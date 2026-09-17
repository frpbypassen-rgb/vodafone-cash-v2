'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const axios = require('axios');
const MerchantWebhookEndpoint = require('../models/MerchantWebhookEndpoint');
const MerchantWebhookDelivery = require('../models/MerchantWebhookDelivery');
const User = require('../models/User');
const { decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

const EVENTS = Object.freeze(['transfer.created', 'transfer.completed', 'transfer.cancelled']);
const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const LOCK_TIMEOUT_MS = 2 * 60_000;

const isPrivateAddress = (address) => {
    if (!address) return true;
    if (address === '::1' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
    if (!net.isIPv4(address)) return false;
    const parts = address.split('.').map(Number);
    return parts[0] === 10
        || parts[0] === 127
        || (parts[0] === 169 && parts[1] === 254)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168)
        || parts[0] === 0;
};

const validateWebhookUrl = async (value) => {
    let parsed;
    try { parsed = new URL(String(value || '').trim()); } catch (_) { throw new Error('INVALID_WEBHOOK_URL'); }
    if (parsed.protocol !== 'https:') throw new Error('WEBHOOK_HTTPS_REQUIRED');
    if (parsed.username || parsed.password || parsed.port && !['443', ''].includes(parsed.port)) throw new Error('INVALID_WEBHOOK_URL');
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.local') || isPrivateAddress(hostname)) throw new Error('WEBHOOK_PRIVATE_ADDRESS');
    let addresses;
    try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); } catch (_) { throw new Error('WEBHOOK_HOST_UNRESOLVED'); }
    if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error('WEBHOOK_PRIVATE_ADDRESS');
    parsed.hash = '';
    return parsed.toString();
};

const normalizeEvents = (events) => {
    const values = Array.isArray(events) ? events : [events];
    const normalized = [...new Set(values.map(String).filter((event) => EVENTS.includes(event)))];
    if (!normalized.length) throw new Error('WEBHOOK_EVENTS_REQUIRED');
    return normalized;
};

const publicEndpoint = (endpoint) => ({
    id: String(endpoint._id), name: endpoint.name, url: endpoint.url,
    events: endpoint.events, enabled: endpoint.enabled, secretHint: endpoint.secretHint,
    failureCount: endpoint.failureCount || 0, lastAttemptAt: endpoint.lastAttemptAt,
    lastSuccessAt: endpoint.lastSuccessAt, lastFailureAt: endpoint.lastFailureAt,
    lastError: endpoint.lastError || '', createdAt: endpoint.createdAt, updatedAt: endpoint.updatedAt
});

const resolveOwner = async (transaction) => {
    if (transaction.companyId) return { ownerModel: 'ClientCompany', ownerId: transaction.companyId };
    if (transaction.clientActorModel === 'User' && transaction.clientActorId) {
        return { ownerModel: 'User', ownerId: transaction.clientActorId };
    }
    const key = String(transaction.userId || '');
    if (!key) return null;
    const conditions = [{ phone: key }, { webUsername: key }];
    if (/^[a-f\d]{24}$/i.test(key)) conditions.unshift({ _id: key });
    const agent = await User.findOne({ role: 'agent', $or: conditions }).select('_id').lean();
    return agent ? { ownerModel: 'User', ownerId: agent._id } : null;
};

const buildPayload = (eventType, transaction) => ({
    id: crypto.randomUUID(),
    type: eventType,
    created_at: new Date().toISOString(),
    data: {
        transaction_id: String(transaction._id),
        reference: transaction.customId,
        status: transaction.status,
        transfer_type: transaction.transferType,
        amount: Number(transaction.amount || 0),
        cost_lyd: Number(transaction.costLYD || 0),
        exchange_rate: Number(transaction.exchangeRate || 0),
        completed_at: transaction.completedAt || null,
        cancellation_number: transaction.cancellationNumber || null,
        cancellation_reason: transaction.cancellationReason || null
    }
});

const signPayload = (secret, timestamp, rawBody) => crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

const claimDelivery = (id) => MerchantWebhookDelivery.findOneAndUpdate({
    _id: id,
    $or: [
        { status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: new Date() } },
        { status: 'sending', lockedAt: { $lte: new Date(Date.now() - LOCK_TIMEOUT_MS) } }
    ],
    attemptCount: { $lt: MAX_ATTEMPTS }
}, {
    $set: { status: 'sending', lockedAt: new Date(), lastAttemptAt: new Date() },
    $inc: { attemptCount: 1 }
}, { returnDocument: 'after' });

const deliverWebhook = async (deliveryId) => {
    const delivery = await claimDelivery(deliveryId);
    if (!delivery) return null;
    const endpoint = await MerchantWebhookEndpoint.findOne({ _id: delivery.endpointId, enabled: true }).select('+secretEncrypted');
    if (!endpoint) {
        await MerchantWebhookDelivery.updateOne({ _id: delivery._id }, { $set: { status: 'failed', lastError: 'ENDPOINT_DISABLED', lockedAt: null } });
        return null;
    }

    try {
        const safeUrl = await validateWebhookUrl(endpoint.url);
        const rawBody = JSON.stringify(delivery.payload);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = signPayload(decrypt(endpoint.secretEncrypted), timestamp, rawBody);
        const response = await axios.post(safeUrl, rawBody, {
            timeout: 10_000, maxRedirects: 0, maxContentLength: 256 * 1024,
            headers: {
                'content-type': 'application/json',
                'user-agent': 'AhramPay-Webhooks/1.0',
                'x-ahrampay-event': delivery.eventType,
                'x-ahrampay-delivery': String(delivery._id),
                'x-ahrampay-timestamp': timestamp,
                'x-ahrampay-signature': `sha256=${signature}`
            },
            validateStatus: () => true
        });
        const responsePreview = typeof response.data === 'string'
            ? response.data.slice(0, 500)
            : JSON.stringify(response.data || {}).slice(0, 500);
        if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`HTTP_${response.status}`), { responseCode: response.status, responsePreview });

        await Promise.all([
            MerchantWebhookDelivery.updateOne({ _id: delivery._id }, { $set: {
                status: 'delivered', responseCode: response.status, responsePreview,
                lastError: '', deliveredAt: new Date(), lockedAt: null
            } }),
            MerchantWebhookEndpoint.updateOne({ _id: endpoint._id }, { $set: {
                failureCount: 0, lastAttemptAt: new Date(), lastSuccessAt: new Date(), lastError: ''
            } })
        ]);
        return { delivered: true };
    } catch (error) {
        const exhausted = delivery.attemptCount >= MAX_ATTEMPTS;
        const delay = RETRY_DELAYS_MS[Math.min(delivery.attemptCount - 1, RETRY_DELAYS_MS.length - 1)];
        await Promise.all([
            MerchantWebhookDelivery.updateOne({ _id: delivery._id }, { $set: {
                status: 'failed', responseCode: error.responseCode || null,
                responsePreview: error.responsePreview || '', lastError: String(error.message || 'DELIVERY_FAILED').slice(0, 500),
                nextAttemptAt: exhausted ? null : new Date(Date.now() + delay), lockedAt: null
            } }),
            MerchantWebhookEndpoint.updateOne({ _id: endpoint._id }, {
                $inc: { failureCount: 1 },
                $set: { lastAttemptAt: new Date(), lastFailureAt: new Date(), lastError: String(error.message || 'DELIVERY_FAILED').slice(0, 500) }
            })
        ]);
        logger.warn('Merchant webhook delivery failed', { deliveryId: String(delivery._id), endpointId: String(endpoint._id), attempt: delivery.attemptCount, error: error.message });
        return { delivered: false, exhausted };
    }
};

const enqueueTransactionWebhook = async (eventType, transaction) => {
    if (!EVENTS.includes(eventType) || !transaction) return [];
    const owner = await resolveOwner(transaction);
    if (!owner) return [];
    const endpointQuery = { ...owner, enabled: true, events: eventType };
    // Legacy transactions may not contain a tenant id. Ownership remains the
    // mandatory boundary, while tenant scoping is applied whenever available.
    if (transaction.tenantId) endpointQuery.tenantId = transaction.tenantId;
    const endpoints = await MerchantWebhookEndpoint.find(endpointQuery).lean();
    if (!endpoints.length) return [];
    const payload = buildPayload(eventType, transaction);
    const eventId = `${transaction._id}:${eventType}:${transaction.status || ''}`;
    const operations = endpoints.map((endpoint) => ({
        updateOne: {
            filter: { endpointId: endpoint._id, eventId },
            update: { $setOnInsert: {
                tenantId: endpoint.tenantId || transaction.tenantId || null, endpointId: endpoint._id, ...owner,
                eventId, eventType, payload, status: 'pending', nextAttemptAt: new Date()
            } },
            upsert: true
        }
    }));
    await MerchantWebhookDelivery.bulkWrite(operations, { ordered: false });
    const deliveries = await MerchantWebhookDelivery.find({ endpointId: { $in: endpoints.map((item) => item._id) }, eventId }).select('_id').lean();
    deliveries.forEach((item) => { deliverWebhook(item._id).catch((error) => logger.error('Merchant webhook dispatch failed', { error: error.message })); });
    return deliveries.map((item) => item._id);
};

const ensureMerchantWebhookIndexes = () => Promise.all([
    MerchantWebhookEndpoint.createIndexes(),
    MerchantWebhookDelivery.createIndexes()
]);

const processPendingWebhooks = async (limit = 50) => {
    const rows = await MerchantWebhookDelivery.find({
        status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: new Date() }, attemptCount: { $lt: MAX_ATTEMPTS }
    }).sort({ nextAttemptAt: 1 }).limit(limit).select('_id').lean();
    await Promise.allSettled(rows.map((row) => deliverWebhook(row._id)));
    return rows.length;
};

let workerTimer = null;
const startMerchantWebhookWorker = () => {
    if (workerTimer) return workerTimer;
    workerTimer = setInterval(() => {
        processPendingWebhooks().catch((error) => logger.error('Merchant webhook worker failed', { error: error.message }));
    }, 30_000);
    if (typeof workerTimer.unref === 'function') workerTimer.unref();
    return workerTimer;
};

module.exports = {
    EVENTS, MAX_ATTEMPTS, buildPayload, deliverWebhook, enqueueTransactionWebhook,
    ensureMerchantWebhookIndexes,
    normalizeEvents, processPendingWebhooks, publicEndpoint, signPayload,
    startMerchantWebhookWorker, validateWebhookUrl
};
