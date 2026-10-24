'use strict';

// Only notification collections are written here. Financial records are read
// after commit; no payment, provider request, settlement or refund dependencies.
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const Admin = require('../models/Admin');
const { AdminOperationAlert: Alert, AdminAlertState: State, AdminPushDevice: Device, AdminPushDelivery: Delivery } = require('../models/AdminOperationAlert');
const { canReviewProviderOperation, pendingProviderQuery } = require('../utils/providerPendingOperation');
const { permissionsForRole } = require('../config/adminRoles');
const { getConfiguration, isConfigured } = require('./executorWebPushService');
const { normalizeAdminPushSubscription: normalizeSubscription } = require('../utils/adminPushSubscription');
const logger = require('../utils/logger');

const OPERATION_STATUSES = ['pending', 'processing', 'accepted', 'completed', 'rejected', 'cancelled_by_admin'];
const FIELDS = '_id tenantId customId transferType canonicalServiceKey createdAt updatedAt status apiResultData';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const enabled = () => process.env.ADMIN_OPERATION_ALERTS_ENABLED !== 'false';
const providerPending = tx => canReviewProviderOperation(tx)
    // A successful receipt waiting for scheduled completion is not a provider hold.
    && !(tx.apiResultData?.waitingApiAutoCompletion && tx.apiResultData?.referenceMasked === true
        && !tx.apiResultData?.providerResultUnresolved);
const canRead = admin => admin?.status === 'active'
    && permissionsForRole(admin.role, admin.permissions).some(p => p === '*' || p === 'transactions.read');
const deviceAuthorized = async device => {
    if (!device?.active) return false;
    if (device.adminId === 'master_admin') return true; // Built-in master principal, registered through an authenticated session.
    const admin = await Admin.findById(device.adminId).select('status role permissions sessionVersion').lean();
    return canRead(admin) && Number(admin.sessionVersion || 0) === Number(device.sessionVersion || 0);
};
const deviceCanSee = (device, alert) => device.allTenants || String(device.tenantId || '') === String(alert.tenantId || '');
const urlFor = alert => `/transactions/operations?${alert.kind === 'api_pending' ? 'providerReview=1&' : ''}search=${encodeURIComponent(alert.reference || alert.transactionId)}`;
const publicAlert = alert => ({
    id: alert._id, kind: alert.kind, reference: alert.reference, service: alert.service,
    createdAt: alert.createdAt, occurredAt: alert.occurredAt, url: urlFor(alert),
    acknowledgedName: alert.acknowledgedName || '', acknowledgedAt: alert.acknowledgedAt,
    resolvedAt: alert.resolvedAt
});

async function registerDevice({ actor, tenantId, allTenants, subscription, sessionVersion, sessionId }) {
    const normalized = normalizeSubscription(subscription);
    const id = hash(normalized.endpoint);
    if (await Device.countDocuments({ adminId: actor.id, active: true, _id: { $ne: id } }) >= 10) {
        throw new Error('وصلت إلى الحد الأقصى للأجهزة (10). عطّل جهازًا قديمًا أولاً.');
    }
    await Device.findOneAndUpdate({ _id: id }, { $set: {
        adminId: actor.id, tenantId: tenantId || null, allTenants, sessionVersion, sessionBinding: hash(sessionId),
        subscription: normalized.subscription, active: true, lastError: ''
    } }, { upsert: true });
    return id;
}

async function recordAlert(tx, kind) {
    const id = `${kind}:${tx._id}`;
    try {
        await Alert.updateOne({ _id: id }, { $setOnInsert: {
            transactionId: tx._id, tenantId: tx.tenantId, kind, reference: tx.customId,
            service: tx.canonicalServiceKey || tx.transferType,
            occurredAt: kind === 'new_operation' ? tx.createdAt : new Date(), createdAt: new Date(), updatedAt: new Date()
        } }, { upsert: true, timestamps: false });
    } catch (error) { if (error.code !== 11000) throw error; }
}

async function recordBatch(rows, kind) {
    if (!rows.length) return;
    const now = new Date();
    try {
        await Alert.bulkWrite(rows.map(tx => ({ updateOne: {
            filter: { _id: `${kind}:${tx._id}` }, upsert: true, timestamps: false,
            update: { $setOnInsert: { transactionId: tx._id, tenantId: tx.tenantId, kind,
                reference: tx.customId, service: tx.canonicalServiceKey || tx.transferType,
                occurredAt: kind === 'new_operation' ? tx.createdAt : now, createdAt: now, updatedAt: now,
                acknowledgedBy: null, resolvedAt: null, pushQueuedAt: null } }
        } })), { ordered: false });
    } catch (error) {
        if (!error.writeErrors?.length || error.writeErrors.some(item => item.code !== 11000)) throw error;
    }
}

async function scanAlerts(now = new Date()) {
    await State.updateOne({ _id: 'scan' }, { $setOnInsert: { since: now, windowStart: now, windowEnd: now } }, { upsert: true });
    const token = crypto.randomUUID();
    const state = await State.findOneAndUpdate({ _id: 'scan', $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: null }] },
        { $set: { leaseToken: token, leaseUntil: new Date(now.getTime() + 60000) } }, { returnDocument: 'after' });
    if (!state) return;
    try {
        if (!state.cursorAt) state.windowEnd = now;
        const created = { createdAt: { $gte: state.windowStart, $lte: state.windowEnd },
            status: { $in: OPERATION_STATUSES }, transferType: { $ne: 'balance_transfer' } };
        if (state.cursorAt) created.$or = [{ createdAt: { $gt: state.cursorAt } }, { createdAt: state.cursorAt, _id: { $gt: state.cursorId } }];
        const rows = await Transaction.find(created).select(FIELDS).sort({ createdAt: 1, _id: 1 }).limit(200).lean();
        await recordBatch(rows, 'new_operation');
        if (rows.length === 200) {
            state.cursorAt = rows.at(-1).createdAt; state.cursorId = rows.at(-1)._id;
        } else {
            state.windowStart = new Date(Math.max(state.since.getTime(), state.windowEnd.getTime() - 10 * 60000));
            state.cursorAt = null; state.cursorId = null;
        }
        const pending = pendingProviderQuery(now, 0);
        if (state.pendingCursor) pending._id = { $gt: state.pendingCursor };
        const held = await Transaction.find(pending).select(FIELDS).sort({ _id: 1 }).limit(100).lean();
        await recordBatch(held.filter(providerPending), 'api_pending');
        state.pendingCursor = held.length === 100 ? held.at(-1)._id : null;
        await State.updateOne({ _id: 'scan', leaseToken: token }, { $set: {
            windowStart: state.windowStart, windowEnd: state.windowEnd, cursorAt: state.cursorAt,
            cursorId: state.cursorId, pendingCursor: state.pendingCursor
        } });
    } finally { await State.updateOne({ _id: 'scan', leaseToken: token }, { $unset: { leaseToken: '', leaseUntil: '' } }); }
}

async function acknowledge({ id, scope, actor }) {
    const alert = await Alert.findOne({ _id: id, ...scope, kind: 'api_pending' }).lean();
    if (!alert) return null;
    const tx = await Transaction.findOne({ _id: alert.transactionId, ...scope }).select(FIELDS).lean();
    if (!providerPending(tx)) {
        await Alert.updateOne({ _id: id, ...scope }, { $set: { resolvedAt: new Date() } });
        return { ...publicAlert(alert), resolvedAt: new Date() };
    }
    await Alert.updateOne({ _id: id, ...scope, acknowledgedBy: null, resolvedAt: null }, { $set: {
        acknowledgedBy: actor.id, acknowledgedName: actor.name, acknowledgedAt: new Date()
    } });
    return publicAlert(await Alert.findOne({ _id: id, ...scope }).lean());
}

async function listAlerts(scope) {
    const rows = await Alert.find({ $and: [scope, { $or: [
        { createdAt: { $gte: new Date(Date.now() - 86400000) } }, { kind: 'api_pending', resolvedAt: null }
    ] }] }).sort({ createdAt: -1 }).limit(50).lean();
    const pending = rows.filter(row => row.kind === 'api_pending' && !row.resolvedAt);
    const txs = pending.length ? await Transaction.find({ ...scope, _id: { $in: pending.map(row => row.transactionId) } }).select(FIELDS).lean() : [];
    const byId = new Map(txs.map(tx => [String(tx._id), tx]));
    for (const row of pending) {
        if (!providerPending(byId.get(String(row.transactionId)))) {
            row.resolvedAt = new Date();
            await Alert.updateOne({ _id: row._id, ...scope }, { $set: { resolvedAt: row.resolvedAt } });
        }
    }
    return rows.map(publicAlert);
}

async function sendDevice(device, payload) {
    const normalized = normalizeSubscription(device.subscription);
    const config = getConfiguration();
    await require('web-push').sendNotification(normalized.subscription, JSON.stringify(payload), {
        vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
        TTL: 300, urgency: 'high', timeout: 10000
    });
    await Device.updateOne({ _id: device._id, adminId: device.adminId }, { $set: { lastSuccessAt: new Date(), lastError: '' } });
}

async function queuePush(now = new Date()) {
    if (!isConfigured()) return;
    // Recent bounded window: delayed old history must not become a notification storm.
    const alerts = await Alert.find({ pushQueuedAt: null, createdAt: { $gte: new Date(now.getTime() - 10 * 60000) } }).sort({ createdAt: 1 }).limit(100).lean();
    if (!alerts.length) return;
    const devices = await Device.find({ active: true }).lean();
    for (const device of devices) {
        if (!await deviceAuthorized(device)) { await Device.updateOne({ _id: device._id }, { $set: { active: false } }); continue; }
        for (const alert of alerts) {
            if (!deviceCanSee(device, alert) || alert.createdAt < device.createdAt || alert.acknowledgedAt || alert.resolvedAt) continue;
            const id = hash(`${alert._id}:${device._id}:${device.adminId}`);
            try {
                await Delivery.updateOne({ _id: id }, { $setOnInsert: {
                    alertId: alert._id, deviceId: device._id, adminId: device.adminId, status: 'pending', nextAttemptAt: now,
                    expiresAt: new Date(alert.createdAt.getTime() + 10 * 60000)
                } }, { upsert: true, timestamps: false });
            } catch (error) { if (error.code !== 11000) throw error; }
        }
    }
    await Alert.updateMany({ _id: { $in: alerts.map(alert => alert._id) } }, { $set: { pushQueuedAt: now } });
}

async function deliverPush() {
    if (!isConfigured()) return;
    for (let i = 0; i < 10; i += 1) {
        const now = new Date();
        const job = await Delivery.findOneAndUpdate({ status: 'pending', nextAttemptAt: { $lte: now },
            expiresAt: { $gt: now }, attempts: { $lt: 3 }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
        { $set: { leaseUntil: new Date(now.getTime() + 30000) }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { nextAttemptAt: 1 } });
        if (!job) break;
        try {
            const [device, alert] = await Promise.all([Device.findById(job.deviceId).lean(), Alert.findById(job.alertId).lean()]);
            let valid = alert && device && device.adminId === job.adminId && deviceCanSee(device, alert) && await deviceAuthorized(device) && !alert.acknowledgedAt && !alert.resolvedAt;
            if (valid && alert.kind === 'api_pending') valid = providerPending(await Transaction.findById(alert.transactionId).select(FIELDS).lean());
            if (valid) await sendDevice(device, {
                id: alert._id, adminId: device.adminId, kind: alert.kind, url: urlFor(alert),
                title: alert.kind === 'api_pending' ? 'عملية API تحتاج متابعة' : 'عملية جديدة — الأهرام',
                body: alert.kind === 'api_pending' ? 'راجع العملية المعلقة من لوحة الإدارة.' : 'وصلت عملية جديدة إلى لوحة الإدارة.'
            });
            await Delivery.updateOne({ _id: job._id }, { $set: { status: valid ? 'sent' : 'skipped' } });
        } catch (error) {
            const expired = [404, 410].includes(Number(error.statusCode));
            await Delivery.updateOne({ _id: job._id }, { $set: {
                status: expired || job.attempts >= 3 ? 'failed' : 'pending', lastError: 'PUSH_FAILED',
                nextAttemptAt: new Date(Date.now() + 30000), leaseUntil: null
            } });
            await Device.updateOne({ _id: job.deviceId }, { $set: { lastError: 'تعذر إرسال آخر إشعار', ...(expired ? { active: false } : {}) } });
        }
    }
}

let scanTimer, pushTimer, scanning = false, pushing = false;
function startAdminOperationAlerts() {
    if (!enabled() || scanTimer) return;
    const scan = async () => {
        if (scanning) return; scanning = true;
        try { await scanAlerts(); } catch (error) { logger.warn('Admin alert scan failed', { error: error.message }); } finally { scanning = false; }
    };
    const push = async () => {
        if (pushing) return; pushing = true;
        try { await queuePush(); await deliverPush(); } catch (error) { logger.warn('Admin push cycle failed', { error: error.message }); } finally { pushing = false; }
    };
    void scan(); scanTimer = setInterval(scan, 5000); pushTimer = setInterval(push, 10000);
    scanTimer.unref?.(); pushTimer.unref?.();
}
async function initializeAdminOperationAlerts() {
    if (!enabled()) return;
    try {
        await Promise.all([Alert, State, Device, Delivery].map(model => model.createIndexes()));
        startAdminOperationAlerts();
    } catch (error) { logger.warn('Admin alerts initialization failed; financial services remain independent', { error: error.message }); }
}
const disableSessionDevices = (adminId, sessionId) => Device.updateMany({ adminId, sessionBinding: hash(sessionId) }, { $set: { active: false } });
module.exports = { enabled, providerPending, canRead, deviceAuthorized, deviceCanSee, urlFor, publicAlert,
    registerDevice, recordAlert, scanAlerts, acknowledge, listAlerts, sendDevice, queuePush, deliverPush, startAdminOperationAlerts,
    initializeAdminOperationAlerts, disableSessionDevices };
