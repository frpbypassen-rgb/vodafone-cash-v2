'use strict';

const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const logger = require('../utils/logger');

const FIREBASE_APP_NAME = 'ahram-pay-mobile-push';
const MAX_MULTICAST_TOKENS = 500;
const INVALID_TOKEN_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token'
]);

let messagingClient = null;
let initializationAttempted = false;
let initializationError = null;

const enabledByEnvironment = () => {
    const value = String(process.env.FCM_ENABLED || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(value);
};

const parseServiceAccount = () => {
    const encoded = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
    const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (encoded || rawJson) {
        const json = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : rawJson;
        const parsed = JSON.parse(json);
        return {
            projectId: parsed.project_id || parsed.projectId,
            clientEmail: parsed.client_email || parsed.clientEmail,
            privateKey: parsed.private_key || parsed.privateKey
        };
    }

    return {
        projectId: String(process.env.FIREBASE_PROJECT_ID || '').trim(),
        clientEmail: String(process.env.FIREBASE_CLIENT_EMAIL || '').trim(),
        privateKey: String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim()
    };
};

const getFirebasePushStatus = () => {
    let credentials = {};
    try {
        credentials = parseServiceAccount();
    } catch (error) {
        return {
            enabled: enabledByEnvironment(),
            configured: false,
            ready: false,
            code: 'INVALID_SERVICE_ACCOUNT_JSON',
            message: error.message
        };
    }

    const missing = [
        ['FIREBASE_PROJECT_ID', credentials.projectId],
        ['FIREBASE_CLIENT_EMAIL', credentials.clientEmail],
        ['FIREBASE_PRIVATE_KEY', credentials.privateKey]
    ].filter(([, value]) => !value).map(([name]) => name);

    return {
        enabled: enabledByEnvironment(),
        configured: missing.length === 0,
        ready: Boolean(messagingClient),
        projectId: credentials.projectId || '',
        missing,
        code: initializationError ? 'INITIALIZATION_FAILED' : (missing.length ? 'MISSING_CONFIGURATION' : 'READY'),
        message: initializationError?.message || ''
    };
};

const getMessagingClient = () => {
    if (messagingClient) return messagingClient;
    if (initializationAttempted) return null;
    initializationAttempted = true;

    const status = getFirebasePushStatus();
    if (!status.enabled || !status.configured) return null;

    try {
        const serviceAccount = parseServiceAccount();
        const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
        const app = existing || initializeApp({ credential: cert(serviceAccount) }, FIREBASE_APP_NAME);
        messagingClient = getMessaging(app);
        logger.info('Firebase Cloud Messaging initialized', { projectId: serviceAccount.projectId });
        return messagingClient;
    } catch (error) {
        initializationError = error;
        logger.error('Firebase Cloud Messaging initialization failed', { error: error.message });
        return null;
    }
};

// Initialise once during application startup so a bad service account is
// reported immediately.  Previously the worker only tried to initialise FCM
// when there was already a device event in the queue, which made the startup
// diagnostic look configured-but-not-ready and delayed the first alert.
const initializeFirebasePush = () => getMessagingClient();

const normalizeData = (data = {}) => Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
        String(key),
        typeof value === 'string' ? value : JSON.stringify(value ?? '')
    ])
);

const chunksOf = (items, size) => {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
};

const sendPushToTokens = async ({
    tokens,
    title,
    body,
    data = {},
    visible = true,
    channelId = 'executor_tasks',
    sound = 'default',
    collapseKey = '',
    ttlMs = 5 * 60 * 1000,
    androidDataOnly = false
}) => {
    const uniqueTokens = [...new Set((tokens || []).map((token) => String(token || '').trim()).filter(Boolean))];
    if (uniqueTokens.length === 0) {
        return { successCount: 0, failureCount: 0, responses: [] };
    }

    const client = getMessagingClient();
    if (!client) {
        const status = getFirebasePushStatus();
        const error = new Error(status.message || 'Firebase Cloud Messaging is not configured');
        error.code = status.code || 'FCM_NOT_CONFIGURED';
        error.configurationStatus = status;
        throw error;
    }

    const allResponses = [];
    let successCount = 0;
    let failureCount = 0;

    for (const tokenBatch of chunksOf(uniqueTokens, MAX_MULTICAST_TOKENS)) {
        const message = {
            tokens: tokenBatch,
            data: normalizeData({
                ...data,
                ...(visible ? { notificationTitle: title, notificationBody: body } : {}),
                channelId,
                sound
            }),
            android: {
                priority: 'high',
                ttl: Math.max(0, Number(ttlMs) || 0),
                ...(collapseKey ? { collapseKey } : {}),
                ...(visible && !androidDataOnly ? {
                    notification: {
                        channelId,
                        sound: sound || 'default',
                        priority: 'max',
                        visibility: 'public',
                        tag: collapseKey || undefined
                    }
                } : {})
            },
            apns: {
                headers: { 'apns-priority': '10' },
                payload: {
                    aps: {
                        contentAvailable: true,
                        ...(visible ? {
                            sound: sound || 'default',
                            alert: { title, body }
                        } : {})
                    }
                }
            },
            ...(visible && !androidDataOnly ? { notification: { title, body } } : {})
        };
        const result = await client.sendEachForMulticast(message);
        successCount += result.successCount;
        failureCount += result.failureCount;
        result.responses.forEach((response, index) => {
            allResponses.push({ token: tokenBatch[index], ...response });
        });
    }

    return { successCount, failureCount, responses: allResponses };
};

const isInvalidPushTokenError = (error) => INVALID_TOKEN_CODES.has(error?.code);

const resetFirebasePushForTests = () => {
    messagingClient = null;
    initializationAttempted = false;
    initializationError = null;
};

const setMessagingClientForTests = (client) => {
    messagingClient = client;
    initializationAttempted = true;
    initializationError = null;
};

module.exports = {
    getFirebasePushStatus,
    initializeFirebasePush,
    getMessagingClient,
    sendPushToTokens,
    isInvalidPushTokenError,
    resetFirebasePushForTests,
    setMessagingClientForTests
};
