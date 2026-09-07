'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const MerchantWebhookSubscription = require('../models/MerchantWebhookSubscription');
const MerchantWebhookDelivery = require('../models/MerchantWebhookDelivery');
const { encrypt, decrypt } = require('./accountMfaService');

const SUPPORTED_EVENTS = Object.freeze(['transaction.pending', 'transaction.processing', 'transaction.completed', 'transaction.failed']);
const RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000]);
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
let workerTimer = null;
let workerRunning = false;

const eventForStatus = (status) => ({
    pending: 'transaction.pending',
    accepted: 'transaction.processing',
    processing: 'transaction.processing',
    completed: 'transaction.completed',
    rejected: 'transaction.failed',
    cancelled_by_admin: 'transaction.failed'
}[String(status || '').trim()] || null);

const isPrivateIp = (address) => {
    if (net.isIP(address) === 4) {
        const [a, b] = address.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
    }
    const normalized = String(address || '').toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('::ffff:127.');
};

const validateWebhookUrl = async (rawUrl) => {
    let parsed;
    try { parsed = new URL(String(rawUrl || '').trim()); } catch (_) { throw new Error('WEBHOOK_URL_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) throw new Error('WEBHOOK_URL_HTTPS_REQUIRED');
    if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.local')) throw new Error('WEBHOOK_URL_PRIVATE_HOST');
    const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) throw new Error('WEBHOOK_URL_PRIVATE_HOST');
    return parsed.toString();
};

const generateSigningSecret = () => crypto.randomBytes(32).toString('base64url');
const secretFingerprint = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
const signatureFor = ({ timestamp, body, secret }) => `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

const buildPayload = (tx, eventType) => ({
    id: crypto.randomUUID(),
    event: eventType,
    occurred_at: new Date().toISOString(),
    data: {
        transaction_id: String(tx._id),
        reference_id: tx.customId,
        status: tx.status,
        target_number: tx.vodafoneNumber || null,
        amount_egp: Number(tx.amount || 0),
        cost_lyd: Number(tx.costLYD || 0),
        transfer_type: tx.transferType || null,
        completed_at: tx.completedAt ? new Date(tx.completedAt).toISOString() : null,
        cancelled_at: tx.cancelledAt ? new Date(tx.cancelledAt).toISOString() : null,
        cancellation_number: tx.cancellationNumber || null,
        cancellation_reason: tx.cancellationReason || null
    }
});

const queueForTransaction = async (tx) => {
    if (!tx?.companyId) return;
    const eventType = eventForStatus(tx.status);
    if (!eventType) return;
    const subscriptions = await MerchantWebhookSubscription.find({ companyId: tx.companyId, status: 'active', events: eventType }).lean();
    await Promise.all(subscriptions.map(async (subscription) => {
        const payload = buildPayload(tx, eventType);
        // An event is at-least-once. This stable id makes duplicate deliveries safe for receivers.
        payload.id = crypto.createHash('sha256').update(`${subscription._id}:${tx._id}:${eventType}`).digest('hex');
        try {
            await MerchantWebhookDelivery.create({
                subscriptionId: subscription._id,
                companyId: tx.companyId,
                transactionId: tx._id,
                eventType,
                eventId: payload.id,
                payload
            });
        } catch (error) {
            if (error?.code !== 11000) throw error;
        }
    }));
};

const deliver = async (delivery) => {
    const subscription = await MerchantWebhookSubscription.findOne({ _id: delivery.subscriptionId, status: 'active' }).select('+signingSecretEncrypted');
    if (!subscription) {
        await MerchantWebhookDelivery.updateOne({ _id: delivery._id, status: 'sending' }, { $set: { status: 'failed', lastError: 'SUBSCRIPTION_INACTIVE' } });
        return;
    }
    let secret;
    try { secret = decrypt(subscription.signingSecretEncrypted); } catch (_) { secret = ''; }
    if (!secret) {
        await MerchantWebhookDelivery.updateOne({ _id: delivery._id, status: 'sending' }, { $set: { status: 'failed', lastError: 'SIGNING_SECRET_UNAVAILABLE' } });
        return;
    }
    const body = JSON.stringify(delivery.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
        const response = await fetch(subscription.url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: {
                'content-type': 'application/json',
                'user-agent': 'AlAhramPay-Webhooks/1.0',
                'x-ahram-event': delivery.eventType,
                'x-ahram-event-id': delivery.eventId,
                'x-ahram-timestamp': timestamp,
                'x-ahram-signature': signatureFor({ timestamp, body, secret })
            }, body
        });
        if (response.status >= 200 && response.status < 300) {
            await MerchantWebhookDelivery.updateOne({ _id: delivery._id, status: 'sending' }, { $set: { status: 'delivered', deliveredAt: new Date(), lastResponseCode: response.status, lastError: '' } });
            await MerchantWebhookSubscription.updateOne({ _id: subscription._id }, { $set: { lastDeliveredAt: new Date(), failureCount: 0 } });
            return;
        }
        throw Object.assign(new Error(`HTTP_${response.status}`), { responseCode: response.status });
    } catch (error) {
        const attempts = Number(delivery.attempts || 0) + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        const retryDelay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
        await MerchantWebhookDelivery.updateOne({ _id: delivery._id, status: 'sending' }, { $set: {
            status: exhausted ? 'failed' : 'pending', attempts, lastAttemptAt: new Date(),
            lastResponseCode: error.responseCode || null, lastError: String(error.message || 'DELIVERY_FAILED').slice(0, 500),
            nextAttemptAt: new Date(Date.now() + retryDelay)
        } });
        await MerchantWebhookSubscription.updateOne({ _id: subscription._id }, { $set: { lastFailureAt: new Date() }, $inc: { failureCount: 1 } });
    }
};

const processPendingDeliveries = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
        for (let index = 0; index < 20; index += 1) {
            const delivery = await MerchantWebhookDelivery.findOneAndUpdate(
                { status: 'pending', nextAttemptAt: { $lte: new Date() } },
                { $set: { status: 'sending', lastAttemptAt: new Date() } },
                { new: true }
            ).lean();
            if (!delivery) break;
            await deliver(delivery);
        }
    } finally { workerRunning = false; }
};

const startMerchantWebhookWorker = () => {
    if (workerTimer) return;
    workerTimer = setInterval(() => { processPendingDeliveries().catch((error) => console.error('[MerchantWebhook] worker failed:', error.message)); }, 5_000);
    workerTimer.unref?.();
    processPendingDeliveries().catch((error) => console.error('[MerchantWebhook] initial worker failed:', error.message));
};

const createSubscription = async ({ companyId, url, events, createdBy }) => {
    const verifiedUrl = await validateWebhookUrl(url);
    const signingSecret = generateSigningSecret();
    const subscription = await MerchantWebhookSubscription.create({
        companyId, url: verifiedUrl,
        events: [...new Set((Array.isArray(events) ? events : []).filter((event) => SUPPORTED_EVENTS.includes(event)))],
        signingSecretEncrypted: encrypt(signingSecret), secretFingerprint: secretFingerprint(signingSecret), createdBy
    });
    return { subscription, signingSecret };
};

const rotateSubscriptionSecret = async (subscription) => {
    const signingSecret = generateSigningSecret();
    subscription.signingSecretEncrypted = encrypt(signingSecret);
    subscription.secretFingerprint = secretFingerprint(signingSecret);
    subscription.rotatedAt = new Date();
    await subscription.save();
    return signingSecret;
};

module.exports = { SUPPORTED_EVENTS, validateWebhookUrl, queueForTransaction, processPendingDeliveries, startMerchantWebhookWorker, createSubscription, rotateSubscriptionSecret };
