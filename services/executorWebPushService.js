'use strict';

const { ECDH } = require('node:crypto');
const WebPushSubscription = require('../models/WebPushSubscription');

const MAX_ACCOUNT_SUBSCRIPTIONS = 10;
const MAX_CONCURRENT_SENDS = 4;
const SEND_TIMEOUT_MS = 10000;
const MAX_ENDPOINT_LENGTH = 4096;
const subscriptionUpdates = new Map();
const sendWaiters = [];
let activeSends = 0;

const cleanId = (value) => String(value?._id || value || '').trim();

const subscriptionError = (code = 'INVALID_WEB_PUSH_SUBSCRIPTION') => {
    const error = new Error(code);
    error.code = code;
    return error;
};

const normalizeEndpoint = (value) => {
    if (typeof value !== 'string' || value.length > MAX_ENDPOINT_LENGTH) throw subscriptionError();
    const endpoint = value.trim();
    // Reject ambiguous authorities before passing the canonical URL to web-push's legacy URL parser.
    if (!/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/|\?|$)/i.test(endpoint)
        || /[\s\\#]/.test(endpoint)) throw subscriptionError();
    let url;
    try {
        url = new URL(endpoint);
    } catch {
        throw subscriptionError();
    }
    const allowedHost = url.hostname === 'fcm.googleapis.com'
        || url.hostname === 'updates.push.services.mozilla.com'
        || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+push\.apple\.com$/.test(url.hostname);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443')
        || url.username || url.password || url.hash || !allowedHost) throw subscriptionError();
    return url.href;
};

const decodeKey = (value, bytes) => {
    if (typeof value !== 'string' || value.length > Math.ceil(bytes / 3) * 4
        || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw subscriptionError();
    const decoded = Buffer.from(value, 'base64url');
    const canonical = decoded.toString('base64url');
    const padded = canonical + '='.repeat((4 - canonical.length % 4) % 4);
    if (decoded.length !== bytes || (value !== canonical && value !== padded)) throw subscriptionError();
    return decoded;
};

const storedError = (value) => {
    if (!value) return '';
    return ['INVALID_WEB_PUSH_SUBSCRIPTION', 'WEB_PUSH_SUBSCRIPTION_EXPIRED', 'WEB_PUSH_FAILED'].includes(value)
        ? value : 'WEB_PUSH_FAILED';
};

const withSendSlot = async (send) => {
    if (activeSends >= MAX_CONCURRENT_SENDS) {
        await new Promise((resolve) => sendWaiters.push(resolve));
    } else {
        activeSends += 1;
    }
    try {
        return await send();
    } finally {
        const next = sendWaiters.shift();
        if (next) next();
        else activeSends -= 1;
    }
};

const getConfiguration = () => ({
    publicKey: String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim(),
    privateKey: String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim(),
    subject: String(process.env.WEB_PUSH_SUBJECT || 'mailto:support@ahrampay.com').trim()
});

const isConfigured = () => {
    const config = getConfiguration();
    return Boolean(config.publicKey && config.privateKey && config.subject);
};

const normalizeSubscription = (subscription) => {
    const endpoint = normalizeEndpoint(subscription?.endpoint);
    const publicKey = decodeKey(subscription?.keys?.p256dh, 65);
    const authKey = decodeKey(subscription?.keys?.auth, 16);
    if (publicKey[0] !== 4) throw subscriptionError();
    try {
        ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed');
    } catch {
        throw subscriptionError();
    }
    return {
        endpoint,
        subscription: {
            endpoint,
            expirationTime: subscription.expirationTime || null,
            keys: { p256dh: publicKey.toString('base64url'), auth: authKey.toString('base64url') }
        }
    };
};

const upsertExecutorSubscription = async ({ employeeId, subscription }) => {
    const id = cleanId(employeeId);
    if (!id) throw new Error('INVALID_EXECUTOR_ID');
    const normalized = normalizeSubscription(subscription);
    const update = {
        $set: {
            endpoint: normalized.endpoint,
            subscription: normalized.subscription,
            userId: id,
            accountType: 'executor',
            active: true,
            lastError: ''
        },
    };
    // Serialize this account's registrations in this process; delivery also caps legacy rows independently.
    const previous = subscriptionUpdates.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
        const count = await WebPushSubscription.countDocuments({
            userId: id, accountType: 'executor', endpoint: { $ne: normalized.endpoint }
        });
        if (count >= MAX_ACCOUNT_SUBSCRIPTIONS) {
            const renewed = await WebPushSubscription.findOneAndUpdate(
                { userId: id, accountType: 'executor', endpoint: normalized.endpoint },
                update,
                { returnDocument: 'after' }
            );
            if (renewed) return renewed;
            const recycled = await WebPushSubscription.findOneAndUpdate(
                { userId: id, accountType: 'executor', active: false },
                { $set: { ...update.$set, lastSuccessAt: null } },
                { sort: { updatedAt: 1, _id: 1 }, returnDocument: 'after' }
            );
            if (recycled) return recycled;
            throw subscriptionError('WEB_PUSH_SUBSCRIPTION_LIMIT');
        }
        return WebPushSubscription.findOneAndUpdate(
            { endpoint: normalized.endpoint },
            update,
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
    });
    subscriptionUpdates.set(id, pending);
    try {
        return await pending;
    } finally {
        if (subscriptionUpdates.get(id) === pending) subscriptionUpdates.delete(id);
    }
};

const disableExecutorSubscription = async ({ employeeId, endpoint }) => {
    const suppliedEndpoint = String(endpoint || '').trim();
    let canonicalEndpoint = suppliedEndpoint;
    try {
        if (suppliedEndpoint) canonicalEndpoint = normalizeEndpoint(suppliedEndpoint);
    } catch {
        // Unsafe legacy endpoints still need to be removable without making a request to them.
    }
    const query = {
        userId: cleanId(employeeId),
        accountType: 'executor',
        ...(suppliedEndpoint ? {
            endpoint: canonicalEndpoint === suppliedEndpoint ? suppliedEndpoint
                : { $in: [suppliedEndpoint, canonicalEndpoint] }
        } : {})
    };
    const result = await WebPushSubscription.updateMany(query, { $set: { active: false } });
    return Number(result.modifiedCount || 0);
};

const getExecutorWebPushStatus = async (employeeId) => {
    const id = cleanId(employeeId);
    const [activeSubscriptions, lastSubscription] = await Promise.all([
        WebPushSubscription.countDocuments({ userId: id, accountType: 'executor', active: true }),
        WebPushSubscription.findOne({ userId: id, accountType: 'executor' })
            .sort({ updatedAt: -1 })
            .select('lastSuccessAt lastError updatedAt active')
            .lean()
    ]);
    const config = getConfiguration();
    return {
        configured: isConfigured(),
        publicKey: config.publicKey,
        activeSubscriptions,
        lastSuccessAt: lastSubscription?.lastSuccessAt || null,
        lastError: storedError(lastSubscription?.lastError),
        subscribed: activeSubscriptions > 0
    };
};

const sendExecutorWebPush = async ({
    employeeIds = [],
    title,
    body,
    category = 'executor_update',
    data = {},
    collapseKey = '',
    ttl = 180,
    urgency = 'high'
}) => {
    const ids = [...new Set(employeeIds.map(cleanId).filter(Boolean))];
    if (!isConfigured() || ids.length === 0) {
        return { configured: isConfigured(), attempted: 0, sent: 0, failed: 0 };
    }

    const webpush = require('web-push');
    const config = getConfiguration();
    let vapidReady = false;
    const message = JSON.stringify({
        title: String(title || 'Ahram Pay - بوابة التنفيذ'),
        message: String(body || 'يوجد تحديث جديد في بوابة التنفيذ.'),
        tag: collapseKey || `${category}-${Date.now()}`,
        data: {
            ...data,
            category,
            collapseKey,
            url: data.url || data.route || '/executor-portal/dashboard'
        }
    });

    const sendSubscription = async (row, id) => {
        const filter = {
            _id: row._id, userId: id, accountType: 'executor', endpoint: row.endpoint, active: true
        };
        let normalized;
        try {
            normalized = normalizeSubscription(row.subscription);
            if (normalizeEndpoint(row.endpoint) !== normalized.endpoint) throw subscriptionError();
        } catch {
            await WebPushSubscription.updateOne(filter, {
                $set: { active: false, lastError: 'INVALID_WEB_PUSH_SUBSCRIPTION' }
            });
            return false;
        }
        if (!vapidReady) {
            webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
            vapidReady = true;
        }
        try {
            await webpush.sendNotification(normalized.subscription, message, {
                TTL: Math.max(60, Number(ttl) || 180),
                urgency,
                timeout: SEND_TIMEOUT_MS
            });
            await WebPushSubscription.updateOne(
                filter,
                { $set: { lastSuccessAt: new Date(), lastError: '' } }
            );
            return true;
        } catch (error) {
            const expired = [404, 410].includes(Number(error?.statusCode));
            await WebPushSubscription.updateOne(
                filter,
                {
                    $set: {
                        ...(expired ? { active: false } : {}),
                        lastError: expired ? 'WEB_PUSH_SUBSCRIPTION_EXPIRED' : 'WEB_PUSH_FAILED'
                    }
                }
            );
            return false;
        }
    };

    const summary = { configured: true, attempted: 0, sent: 0, failed: 0 };
    for (const id of ids) {
        const subscriptions = await WebPushSubscription.find({
            accountType: 'executor', userId: id, active: true
        }).sort({ updatedAt: -1, _id: -1 }).limit(MAX_ACCOUNT_SUBSCRIPTIONS).lean();
        for (let start = 0; start < subscriptions.length; start += MAX_CONCURRENT_SENDS) {
            const results = await Promise.all(subscriptions.slice(start, start + MAX_CONCURRENT_SENDS)
                .map((row) => withSendSlot(() => sendSubscription(row, id))));
            summary.attempted += results.length;
            summary.sent += results.filter(Boolean).length;
            summary.failed += results.filter((result) => !result).length;
        }
    }
    return summary;
};

const sendExecutorWebPushTest = (employeeId) => sendExecutorWebPush({
    employeeIds: [employeeId],
    title: 'اختبار إشعارات Ahram Pay',
    body: 'تم ربط هذا المتصفح بنجاح بإشعارات بوابة التنفيذ.',
    category: 'executor_push_test',
    collapseKey: `executor-web-test-${cleanId(employeeId)}`,
    data: { url: '/executor-portal/settings', priority: 'high' }
});

module.exports = {
    disableExecutorSubscription,
    getConfiguration,
    getExecutorWebPushStatus,
    isConfigured,
    normalizeSubscription,
    sendExecutorWebPush,
    sendExecutorWebPushTest,
    upsertExecutorSubscription
};
