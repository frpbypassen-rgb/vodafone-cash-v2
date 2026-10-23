'use strict';

// Observes provider receipts only. This module deliberately has no payment,
// wallet, refund, completion or queue dependencies.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Notification = require('../models/Notification');
const { getApiProviderTransaction, isMaskedProviderReference } = require('./externalApiService');
const { pendingProviderQuery, canReviewProviderOperation, providerTransactionIdOf, providerOperationMatches } = require('../utils/providerPendingOperation');
const { isFinancialSchedulersEnabled, isExternalApiEnabled, isSwitchEnabled } = require('../utils/runtimeControls');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 10;
const MINIMUM_AGE_MS = 5 * 60 * 1000;
const INTERVAL_MS = 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const BACKOFF_MS = [5, 10, 20, 30, 60, 120, 120, 120].map((minutes) => minutes * 60000);
let timer = null;
let running = false;

const monitorEnabled = () => isFinancialSchedulersEnabled() && isExternalApiEnabled()
    && isSwitchEnabled(process.env.API_PENDING_MONITOR_ENABLED);

const stateLabels = {
    awaiting: 'بانتظار الفحص', pending: 'ما زالت معلقة لدى المزود',
    paid: 'المزود يؤكد النجاح — تحتاج اعتماد الإدارة', returned: 'المزود أفاد بالإلغاء أو الرد — تحتاج مراجعة',
    mismatch: 'بيانات الرد غير مطابقة أو ناقصة', failed: 'تعذر الاتصال بالمزود',
    missing_reference: 'رقم عملية المزود غير متوفر', missing_executor: 'إعدادات المنفذ غير متاحة',
    exhausted: 'توقفت المتابعة بعد الحد الأقصى للمحاولات'
};

const classifyObservation = (tx, result) => {
    if (!result.success) return 'failed';
    if (!providerOperationMatches(tx, result)) return 'mismatch';
    if (result.isReturned) return 'returned';
    if (isMaskedProviderReference(result.referenceNumber)) return 'paid';
    return 'pending';
};

// Durable internal notification outbox. Deterministic _id uses MongoDB's
// built-in unique index, including deployments without a dedupeKey index.
const flushMonitorAlerts = async () => {
    const rows = await Transaction.find({ 'apiResultData.providerMonitorAlertPending': true })
        .select('_id tenantId customId status apiResultData.providerResolutionOutcome apiResultData.providerMonitorAlert').limit(20).lean();
    for (const tx of rows) {
        const alert = tx.apiResultData?.providerMonitorAlert;
        if (!alert?.fingerprint) continue;
        if (!['pending', 'processing', 'accepted'].includes(tx.status) || tx.apiResultData.providerResolutionOutcome) {
            await Transaction.updateOne({ _id: tx._id, 'apiResultData.providerMonitorAlert.fingerprint': alert.fingerprint }, {
                $set: { 'apiResultData.providerMonitorAlertPending': false }
            }, { timestamps: false });
            continue;
        }
        const id = crypto.createHash('sha256').update(`${tx._id}:${alert.fingerprint}`).digest('hex').slice(0, 24);
        try {
            await Notification.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $setOnInsert: {
                tenantId: tx.tenantId, audience: 'admin', targetModel: 'Transaction', targetId: tx._id,
                txId: tx.customId, type: 'api_pending_review', title: alert.title, message: alert.message,
                metadata: { transactionId: String(tx._id), state: alert.state,
                    url: `/transactions/operations?providerReview=1&search=${encodeURIComponent(tx.customId || String(tx._id))}` },
                isRead: false
            } }, { upsert: true });
            await Transaction.updateOne({ _id: tx._id, 'apiResultData.providerMonitorAlert.fingerprint': alert.fingerprint }, {
                $set: { 'apiResultData.providerMonitorAlertPending': false }
            }, { timestamps: false });
        } catch (error) {
            logger.warn('Pending API review notification will retry', { txId: tx.customId, error: error.message });
        }
    }
};

const checkPendingOperation = async (candidate, now = new Date()) => {
    if (!canReviewProviderOperation(candidate)) return { checked: false };
    const token = crypto.randomUUID();
    const due = { $or: [
        { 'apiResultData.providerMonitorNextCheckAt': { $exists: false } },
        { 'apiResultData.providerMonitorNextCheckAt': { $lte: now } }
    ] };
    const leaseFree = { $or: [
        { 'apiResultData.providerMonitorLeaseUntil': { $exists: false } },
        { 'apiResultData.providerMonitorLeaseUntil': { $lte: now } }
    ] };
    const tx = await Transaction.findOneAndUpdate({
        _id: candidate._id, updatedAt: candidate.updatedAt,
        'apiResultData.providerMonitorStopped': { $ne: true },
        $and: [pendingProviderQuery(now), due, leaseFree]
    }, { $set: {
        'apiResultData.providerMonitorLeaseToken': token,
        'apiResultData.providerMonitorLeaseUntil': new Date(now.getTime() + LEASE_MS)
    } }, { returnDocument: 'after', timestamps: false });
    if (!tx) return { checked: false };
    const data = tx.apiResultData || {};
    let result = null;
    let state;
    try {
        const providerId = providerTransactionIdOf(tx);
        const previousAttempts = Number(data.providerMonitorAttempts || 0);
        if (previousAttempts >= MAX_ATTEMPTS) state = 'exhausted';
        else if (!providerId) state = 'missing_reference';
        else {
            const group = await ExecutorGroup.findById(tx.executorGroupId);
            if (!group || !(group.isApiBot || group.isApiGroup) || (tx.tenantId && String(tx.tenantId) !== String(group.tenantId))) {
                state = 'missing_executor';
            } else {
                try { result = await getApiProviderTransaction(group, providerId); }
                catch (_) { result = { success: false }; }
                state = classifyObservation(tx, result);
            }
        }
        const attempts = Math.min(MAX_ATTEMPTS, previousAttempts + 1);
        const failures = state === 'failed' ? Number(data.providerMonitorFailures || 0) + 1 : 0;
        const stopped = !['pending', 'failed'].includes(state) || attempts >= MAX_ATTEMPTS;
        const finalState = attempts >= MAX_ATTEMPTS && ['pending', 'failed'].includes(state) ? 'exhausted' : state;
        const checkedAt = new Date();
        const metadata = {
            providerMonitorAttempts: attempts, providerMonitorFailures: failures,
            providerMonitorState: finalState, providerMonitorStopped: stopped,
            providerMonitorNextCheckAt: stopped ? null : new Date(checkedAt.getTime() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]),
            providerMonitorCheckedAt: checkedAt,
            providerMonitorMessage: stateLabels[finalState]
        };
        if (result) {
            metadata.providerLastCheckedAt = checkedAt;
            metadata.providerStatusCheckSucceeded = Boolean(result.success);
            // Keep the last successful receipt when the network fails.
            if (result.success) Object.assign(metadata, {
                providerReportedStatus: result.providerStatus || '', providerReportedReference: result.referenceNumber || '',
                providerReportedPhone: result.phone || '', providerReportedAmount: result.amount,
                ...(result.isReturned ? { providerReturnDetectedAt: checkedAt } : {})
            });
        }
        const shouldAlert = stopped || failures >= 3;
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
            finalState, result?.success ? result.providerStatus : '', result?.success ? result.referenceNumber : ''
        ])).digest('hex');
        if (shouldAlert && fingerprint !== data.providerMonitorAlertFingerprint) {
            metadata.providerMonitorAlertFingerprint = fingerprint;
            metadata.providerMonitorAlertPending = true;
            metadata.providerMonitorAlert = {
                fingerprint, state: finalState, title: 'عملية API تحتاج مراجعة الإدارة',
                message: `${tx.customId || tx._id}: ${stateLabels[finalState]}. لم تتغير حالة العملية أو الأرصدة.`
            };
        }
        const update = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`apiResultData.${key}`, value]));
        const saved = await Transaction.updateOne({
            _id: tx._id, updatedAt: tx.updatedAt, status: tx.status, executorGroupId: tx.executorGroupId,
            'apiResultData.providerMonitorLeaseToken': token,
            'apiResultData.providerResolutionOutcome': { $in: [null, ''] }
        }, { $set: update, $unset: { 'apiResultData.providerMonitorLeaseToken': '', 'apiResultData.providerMonitorLeaseUntil': '' } });
        return { checked: true, saved: saved.modifiedCount === 1, state: finalState };
    } finally {
        await Transaction.updateOne({ _id: tx._id, 'apiResultData.providerMonitorLeaseToken': token }, {
            $unset: { 'apiResultData.providerMonitorLeaseToken': '', 'apiResultData.providerMonitorLeaseUntil': '' }
        }, { timestamps: false });
    }
};

const runPendingMonitorCycle = async () => {
    if (running || !monitorEnabled()) return { skipped: true };
    running = true;
    let checked = 0;
    try {
        await flushMonitorAlerts();
        const now = new Date();
        const candidates = await Transaction.find({ $and: [pendingProviderQuery(now), {
            'apiResultData.providerMonitorStopped': { $ne: true },
            $or: [{ 'apiResultData.providerMonitorNextCheckAt': { $exists: false } }, { 'apiResultData.providerMonitorNextCheckAt': { $lte: now } }]
        }] }).sort({ 'apiResultData.providerMonitorNextCheckAt': 1, createdAt: 1 }).limit(BATCH_SIZE * 3);
        for (const candidate of candidates) {
            if (checked >= BATCH_SIZE || !monitorEnabled()) break;
            try {
                const result = await checkPendingOperation(candidate, now);
                if (result.checked) checked += 1;
            } catch (error) {
                logger.warn('Pending API monitor could not check row', { txId: candidate.customId, error: error.message });
            }
        }
        await flushMonitorAlerts();
        return { checked };
    } finally { running = false; }
};

const startApiPendingMonitor = () => {
    if (timer || !monitorEnabled()) return timer;
    timer = setInterval(() => runPendingMonitorCycle().catch((error) => {
        logger.error('Pending API monitor cycle failed', { error: error.message });
    }), INTERVAL_MS);
    timer.unref?.();
    return timer;
};
const stopApiPendingMonitor = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = { MAX_ATTEMPTS, MINIMUM_AGE_MS, BATCH_SIZE, INTERVAL_MS, stateLabels, monitorEnabled,
    classifyObservation, checkPendingOperation, flushMonitorAlerts, runPendingMonitorCycle, startApiPendingMonitor, stopApiPendingMonitor };
