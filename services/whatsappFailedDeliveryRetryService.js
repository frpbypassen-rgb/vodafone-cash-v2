'use strict';

const crypto = require('crypto');

const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const Transaction = require('../models/Transaction');
const BulkJobLock = require('../models/BulkJobLock');
const { logAction } = require('./auditService');
const {
    sendCompletedTransactionReceipt,
    sendSplitPartReceipt
} = require('./whatsappReceiptDeliveryService');

// "رسائل متوقفة" on /whatsapp-monitor is WhatsAppDelivery.countDocuments({ status: 'failed' }).
// pending/sending are "بانتظار الإرسال". skipped is "تم التجاوز" and is not stopped.
// sent/delivered/read already reached or may have reached the customer.
const STOPPED_STATUS = 'failed';
const RETRYABLE_KINDS = Object.freeze(['receipt', 'part_receipt']);
const SUCCESS_STATUSES = Object.freeze(['sent', 'delivered', 'read']);
const EXCLUDED_STATUSES = Object.freeze(['pending', 'sending', 'sent', 'delivered', 'read', 'skipped']);
const WINDOW_MS = Object.freeze({
    '24h': 24 * 60 * 60 * 1000,
    '72h': 72 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000
});
const DEFAULT_WINDOW = '72h';
const LOCK_KEY = 'whatsapp-monitor-failed-retry';
const LOCK_TTL_MS = 15 * 60 * 1000;
const SCAN_LIMIT = 1000;

const SUCCESS_STATUS_SET = new Set(SUCCESS_STATUSES);
const RETRYABLE_KIND_SET = new Set(RETRYABLE_KINDS);
const UNRESOLVED_FAILURE_CODES = new Set([
    'WHATCHIMP_TIMEOUT', 'WHATCHIMP_REQUEST_FAILED', 'RETRY_SEND_FAILED',
    'RECEIPT_DELIVERY_FAILED', 'PART_PROOF_SEND_FAILED', 'RETRY_SUPERSEDED'
]);

const readBoundedInt = (name, fallback, min, max) => {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const parsed = Number(String(raw).trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
};

// Unset env keeps the safe default. Out-of-range values are ignored, not widened.
const resolveBatchCap = () => readBoundedInt('WHATSAPP_FAILED_RETRY_BATCH_CAP', 50, 1, 50);
const resolveMaxAttempts = () => readBoundedInt('WHATSAPP_FAILED_RETRY_MAX_ATTEMPTS', 3, 1, 10);
const resolveThrottleMs = (override) => {
    if (override !== undefined && override !== null && override !== '') {
        const parsed = Number(override);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 10000) return parsed;
    }
    return readBoundedInt('WHATSAPP_FAILED_RETRY_THROTTLE_MS', 500, 200, 5000);
};

const resolveWindow = (value, now = new Date()) => {
    const key = Object.prototype.hasOwnProperty.call(WINDOW_MS, String(value || '').trim())
        ? String(value).trim()
        : DEFAULT_WINDOW;
    return { key, since: new Date(now.getTime() - WINDOW_MS[key]) };
};

const hasTenantFilter = (tenantFilter) => Boolean(tenantFilter && Object.keys(tenantFilter).length > 0);

const attemptCount = (delivery) => {
    const value = Number(delivery?.metadata?.manualRetryCount);
    return Number.isFinite(value) && value > 0 ? value : 0;
};

const partKeyOf = (delivery) => String(delivery?.metadata?.partKey || '').trim();

const sameIdentity = (left, right) => String(left || '') === String(right || '');

const hasSuccessfulSibling = (delivery, successes) => (successes || []).some((other) => {
    if (!other || sameIdentity(other._id, delivery._id)) return false;
    if (!sameIdentity(other.transactionId, delivery.transactionId)) return false;
    if (other.kind !== delivery.kind) return false;
    if (!SUCCESS_STATUS_SET.has(other.status)) return false;
    if (delivery.kind === 'part_receipt') return partKeyOf(other) === partKeyOf(delivery);
    return true;
});

const deliveryPublic = (delivery, extra = {}) => ({
    id: String(delivery?._id || ''),
    reference: delivery?.reference || '',
    kind: delivery?.kind || '',
    ...extra
});

/**
 * Why a row must not be retried. Null means eligible.
 * OUT_OF_TENANT_SCOPE is omitted from operator-facing skipped lists.
 */
const ineligibilityReason = (delivery, context) => {
    if (!delivery) return 'NOT_FOUND';
    if (delivery.kind === 'rate_change') return 'RATE_CHANGE_EXCLUDED';
    if (!RETRYABLE_KIND_SET.has(delivery.kind)) return 'KIND_EXCLUDED';
    if (delivery.status !== STOPPED_STATUS) return 'STATUS_NOT_STOPPED';
    if (UNRESOLVED_FAILURE_CODES.has(delivery.failureCode)) return 'PROVIDER_RESULT_UNRESOLVED';
    if (attemptCount(delivery) >= context.maxAttempts) return 'RETRY_CAP_EXCEEDED';
    const updatedAt = new Date(delivery.updatedAt).getTime();
    if (!Number.isFinite(updatedAt) || updatedAt < context.since.getTime()) return 'OUTSIDE_WINDOW';
    if (delivery.kind === 'part_receipt') {
        const partId = String(delivery.metadata?.partId || '').trim();
        const partKey = partKeyOf(delivery);
        if (!partId || !partKey) return 'PART_IDENTITY_MISSING';
    }
    if (!delivery.transactionId || !context.allowedTransactionIds.has(String(delivery.transactionId))) {
        return context.tenantRestricted ? 'OUT_OF_TENANT_SCOPE' : 'TRANSACTION_MISSING';
    }
    if (hasSuccessfulSibling(delivery, context.successes)) return 'ALREADY_SUCCEEDED';
    return null;
};

const SILENT_REASONS = new Set(['OUT_OF_TENANT_SCOPE']);

const partitionCandidates = (rows, context) => {
    const eligible = [];
    const skipped = [];
    (rows || []).forEach((delivery) => {
        const reason = ineligibilityReason(delivery, context);
        if (!reason) {
            eligible.push(delivery);
            return;
        }
        if (SILENT_REASONS.has(reason)) return;
        skipped.push(deliveryPublic(delivery, { reason }));
    });
    return { eligible, skipped };
};

const candidateFilter = (since, maxAttempts) => ({
    status: STOPPED_STATUS,
    kind: { $in: RETRYABLE_KINDS },
    updatedAt: { $gte: since },
    $or: [
        { 'metadata.manualRetryCount': { $exists: false } },
        { 'metadata.manualRetryCount': null },
        { 'metadata.manualRetryCount': { $lt: maxAttempts } }
    ]
});

const loadTransactionsInScope = async (transactionIds, tenantFilter) => {
    if (!transactionIds.length) return [];
    const query = { _id: { $in: transactionIds } };
    if (hasTenantFilter(tenantFilter)) Object.assign(query, tenantFilter);
    return Transaction.find(query).select('_id').lean();
};

const deliveryFilterForTenant = async (match, tenantFilter) => {
    if (!hasTenantFilter(tenantFilter)) return match;
    const transactions = await Transaction.find(tenantFilter).select('_id').lean();
    return { ...match, transactionId: { $in: transactions.map((row) => row._id) } };
};

const planRetries = async ({ tenantFilter = {}, window, now = new Date() } = {}) => {
    const resolved = resolveWindow(window, now);
    const maxAttempts = resolveMaxAttempts();
    const batchCap = resolveBatchCap();
    const filter = await deliveryFilterForTenant(candidateFilter(resolved.since, maxAttempts), tenantFilter);
    const [rows, totalMatched] = await Promise.all([
        WhatsAppDelivery.find(filter).sort({ updatedAt: 1 }).limit(SCAN_LIMIT).lean(),
        WhatsAppDelivery.countDocuments(filter)
    ]);
    const transactionIds = [...new Set(rows.map((row) => row.transactionId).filter(Boolean))];
    const transactions = await loadTransactionsInScope(transactionIds, tenantFilter);
    const allowedTransactionIds = new Set(transactions.map((row) => String(row._id)));
    const allowedOriginalIds = transactionIds.filter((id) => allowedTransactionIds.has(String(id)));
    const successes = allowedOriginalIds.length
        ? await WhatsAppDelivery.find({
            transactionId: { $in: allowedOriginalIds },
            kind: { $in: RETRYABLE_KINDS },
            status: { $in: SUCCESS_STATUSES }
        }).select('kind transactionId status metadata.partKey').lean()
        : [];
    const partitioned = partitionCandidates(rows, {
        successes,
        allowedTransactionIds,
        maxAttempts,
        since: resolved.since,
        tenantRestricted: hasTenantFilter(tenantFilter)
    });
    return {
        window: resolved.key,
        since: resolved.since,
        maxAttempts,
        batchCap,
        eligible: partitioned.eligible,
        skipped: partitioned.skipped,
        unscanned: Math.max(0, totalMatched - rows.length),
        excludedRateChange: true,
        stoppedStatus: STOPPED_STATUS
    };
};

const countByKind = (rows) => rows.reduce((counts, row) => {
    counts[row.kind] = (counts[row.kind] || 0) + 1;
    return counts;
}, { receipt: 0, part_receipt: 0 });

const previewFailedRetries = async (options = {}) => {
    const plan = await planRetries(options);
    const willAttempt = Math.min(plan.eligible.length, plan.batchCap);
    return {
        window: plan.window,
        stoppedStatus: plan.stoppedStatus,
        excludedStatuses: EXCLUDED_STATUSES,
        excludedRateChange: true,
        eligible: plan.eligible.length,
        byKind: countByKind(plan.eligible),
        willAttempt,
        remaining: Math.max(0, plan.eligible.length - plan.batchCap) + plan.unscanned,
        skipped: plan.skipped.length,
        batchCap: plan.batchCap,
        maxAttempts: plan.maxAttempts
    };
};

const scopeListedDeliveries = async (deliveries, tenantFilter) => {
    if (!hasTenantFilter(tenantFilter)) return deliveries || [];
    const transactionIds = [...new Set((deliveries || []).map((row) => row.transactionId).filter(Boolean))];
    const transactions = await loadTransactionsInScope(transactionIds, tenantFilter);
    const allowed = new Set(transactions.map((row) => String(row._id)));
    return (deliveries || []).filter((row) => row.transactionId && allowed.has(String(row.transactionId)));
};

const countDeliveries = async (match, tenantFilter) => {
    return WhatsAppDelivery.countDocuments(await deliveryFilterForTenant(match, tenantFilter));
};

const wait = (ms) => (ms > 0
    ? new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function') timer.unref();
    })
    : Promise.resolve());

const safeMessage = (error) => {
    const message = String(error?.message || 'تعذر إعادة الإرسال.');
    if (/bearer|token|secret|authorization|cookie|api[_-]?key/i.test(message)) return 'تعذر إعادة الإرسال.';
    return message.slice(0, 300);
};

const acquireBulkLock = async () => {
    const ownerId = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
    // Older releases used ObjectId rows and may still have a unique key index.
    const legacyFilter = { key: LOCK_KEY, _id: { $ne: LOCK_KEY } };
    const activeLegacy = await BulkJobLock.collection.findOne({ ...legacyFilter, expiresAt: { $gt: now } });
    if (activeLegacy) return null;
    await BulkJobLock.collection.deleteMany({ ...legacyFilter, expiresAt: { $lte: now } });
    const stolen = await BulkJobLock.findOneAndUpdate(
        { _id: LOCK_KEY, expiresAt: { $lte: now } },
        { $set: { ownerId, expiresAt } },
        { new: true }
    );
    if (stolen) return { ownerId };
    try {
        await BulkJobLock.create({ _id: LOCK_KEY, key: LOCK_KEY, ownerId, expiresAt });
        return { ownerId };
    } catch (error) {
        if (error?.code === 11000) return null;
        throw error;
    }
};

const extendBulkLock = async (ownerId) => {
    const updated = await BulkJobLock.updateOne(
        { _id: LOCK_KEY, ownerId },
        { $set: { expiresAt: new Date(Date.now() + LOCK_TTL_MS) } }
    );
    return Boolean(updated?.matchedCount || updated?.modifiedCount);
};

const releaseBulkLock = async (ownerId) => {
    if (!ownerId) return;
    await BulkJobLock.deleteOne({ _id: LOCK_KEY, ownerId });
};

const claimFilter = (delivery, maxAttempts) => ({
    _id: delivery._id,
    status: STOPPED_STATUS,
    kind: delivery.kind,
    $or: [
        { 'metadata.manualRetryCount': { $exists: false } },
        { 'metadata.manualRetryCount': null },
        { 'metadata.manualRetryCount': { $lt: maxAttempts } }
    ]
});

const repairIfStillSending = async (id, failureCode, failureReason) => {
    await WhatsAppDelivery.updateOne(
        { _id: id, status: 'sending' },
        {
            $set: {
                status: STOPPED_STATUS,
                failureCode: String(failureCode || 'RETRY_SEND_FAILED').slice(0, 120),
                failureReason: String(failureReason || 'تعذر إعادة الإرسال.').slice(0, 1000)
            }
        }
    );
};

const partSendArgs = async (delivery) => {
    const metadata = delivery.metadata || {};
    const partId = String(metadata.partId || '').trim();
    const partKey = partKeyOf(delivery);
    let amount = metadata.amount ?? metadata.partAmount;
    let confirmedAt = metadata.confirmedAt || null;
    if (amount == null || !confirmedAt) {
        const transaction = await Transaction.findById(delivery.transactionId)
            .select('executorSenderEntries completedAt')
            .lean();
        const entry = (transaction?.executorSenderEntries || []).find((item) => String(item?.partId || '') === partId);
        if (amount == null) amount = entry?.amount;
        if (!confirmedAt) confirmedAt = entry?.confirmedAt || transaction?.completedAt || null;
    }
    return {
        transactionId: delivery.transactionId,
        partId,
        partKey,
        amount,
        confirmedAt,
        reference: delivery.reference || undefined
    };
};

const isDuplicateResult = (result) => Boolean(
    result?.duplicate
    || result?.code === 'RECEIPT_ALREADY_SENT'
    || result?.code === 'PART_PROOF_ALREADY_SENT'
);

const retryOne = async (delivery, maxAttempts) => {
    const claimed = await WhatsAppDelivery.findOneAndUpdate(
        claimFilter(delivery, maxAttempts),
        {
            $set: { status: 'sending' },
            $inc: { 'metadata.manualRetryCount': 1 }
        },
        { new: true }
    );
    if (!claimed) return { attempted: false, claimed: false, skipped: deliveryPublic(delivery, { reason: 'CLAIM_LOST' }) };

    let result;
    try {
        result = delivery.kind === 'part_receipt'
            ? await sendSplitPartReceipt(await partSendArgs(delivery))
            : await sendCompletedTransactionReceipt(delivery.transactionId);
    } catch (error) {
        result = { success: false, code: 'RETRY_SEND_FAILED', message: safeMessage(error) };
    }

    if (isDuplicateResult(result)) {
        await repairIfStillSending(delivery._id, 'ALREADY_SUCCEEDED', 'يوجد تسليم ناجح لنفس العملية أو الجزء.');
        return { attempted: false, claimed: true, skipped: deliveryPublic(delivery, { reason: 'ALREADY_SUCCEEDED' }) };
    }

    const fresh = await WhatsAppDelivery.findById(delivery._id).select('status').lean();
    if (!result?.success) {
        if (fresh?.status === 'sending') {
            await repairIfStillSending(
                delivery._id,
                result?.code || 'WHATCHIMP_REQUEST_FAILED',
                result?.message || 'تعذر إعادة الإرسال.'
            );
        }
        const code = result?.code || 'WHATCHIMP_REQUEST_FAILED';
        return {
            attempted: true,
            claimed: true,
            failed: {
                code,
                item: deliveryPublic(delivery, { message: result?.message || '' })
            }
        };
    }

    if (fresh?.status === 'sending') {
        await repairIfStillSending(delivery._id, 'RETRY_SUPERSEDED', 'أُعيد الإرسال على سجل التسليم الحالي للمستلم.');
    }
    return {
        attempted: true,
        claimed: true,
        accepted: deliveryPublic(delivery, { messageId: result.messageId || null })
    };
};

const failureCounts = (failedAgain) => Object.fromEntries(
    Object.entries(failedAgain || {}).map(([code, items]) => [code, Array.isArray(items) ? items.length : 0])
);

const writeAudit = async (req, actor, fields) => logAction({
    req,
    performedById: actor?.id || null,
    performedByModel: 'Admin',
    performedByName: actor?.name || 'الإدارة',
    required: true,
    severity: 'warning',
    ...fields
});

const auditRun = (req, actor, summary) => writeAudit(req, actor, {
    action: 'WHATSAPP_FAILED_DELIVERIES_BULK_RETRY',
    targetModel: 'WhatsAppDelivery',
    success: summary.success !== false,
    errorCode: summary.success === false ? summary.code : undefined,
    metadata: {
        window: summary.window,
        attempted: summary.attempted,
        accepted: summary.accepted.length,
        failedAgain: failureCounts(summary.failedAgain),
        skipped: summary.skipped.length,
        remaining: summary.remaining,
        batchCap: summary.batchCap,
        maxAttempts: summary.maxAttempts,
        excludedRateChange: true,
        stoppedStatus: STOPPED_STATUS
    }
});

const auditRecord = (req, actor, delivery, outcome) => writeAudit(req, actor, {
    action: 'WHATSAPP_FAILED_DELIVERY_RETRIED',
    targetId: delivery._id,
    targetModel: 'WhatsAppDelivery',
    success: Boolean(outcome.accepted),
    errorCode: outcome.failed?.code || outcome.skipped?.reason,
    metadata: {
        bulk: true,
        kind: delivery.kind,
        reference: delivery.reference || '',
        transactionId: String(delivery.transactionId || ''),
        messageId: outcome.accepted?.messageId || null,
        outcome: outcome.accepted ? 'accepted' : (outcome.failed ? 'failed' : 'skipped')
    }
});

const emptySummary = (windowKey, extra = {}) => ({
    success: false,
    window: windowKey,
    stoppedStatus: STOPPED_STATUS,
    excludedRateChange: true,
    attempted: 0,
    accepted: [],
    failedAgain: {},
    skipped: [],
    remaining: 0,
    batchCap: resolveBatchCap(),
    maxAttempts: resolveMaxAttempts(),
    ...extra
});

const retryFailedDeliveries = async ({
    tenantFilter = {},
    window,
    actor,
    req,
    throttleMs,
    now = new Date()
} = {}) => {
    const resolvedWindow = resolveWindow(window, now);
    const lock = await acquireBulkLock();
    if (!lock) {
        const summary = emptySummary(resolvedWindow.key, {
            code: 'BULK_RETRY_BUSY',
            message: 'إعادة المحاولة الجماعية قيد التشغيل بالفعل.'
        });
        await auditRun(req, actor, summary);
        return summary;
    }

    try {
        const plan = await planRetries({ tenantFilter, window: resolvedWindow.key, now });
        const batch = plan.eligible.slice(0, plan.batchCap);
        const summary = {
            success: true,
            code: 'BULK_RETRY_COMPLETED',
            window: plan.window,
            stoppedStatus: STOPPED_STATUS,
            excludedRateChange: true,
            attempted: 0,
            accepted: [],
            failedAgain: {},
            skipped: [...plan.skipped],
            remaining: Math.max(0, plan.eligible.length - batch.length) + plan.unscanned,
            batchCap: plan.batchCap,
            maxAttempts: plan.maxAttempts
        };
        const pauseMs = resolveThrottleMs(throttleMs);

        for (let index = 0; index < batch.length; index += 1) {
            const held = await extendBulkLock(lock.ownerId);
            if (!held) {
                summary.success = false;
                summary.code = 'BULK_RETRY_LOCK_LOST';
                summary.remaining += batch.length - index;
                break;
            }
            if (index > 0) await wait(pauseMs);
            const delivery = batch[index];
            const outcome = await retryOne(delivery, plan.maxAttempts);
            if (outcome.skipped) summary.skipped.push(outcome.skipped);
            if (!outcome.attempted) continue;
            summary.attempted += 1;
            if (outcome.accepted) summary.accepted.push(outcome.accepted);
            if (outcome.failed) {
                const bucket = summary.failedAgain[outcome.failed.code] || [];
                bucket.push(outcome.failed.item);
                summary.failedAgain[outcome.failed.code] = bucket;
            }
            if (outcome.claimed) await auditRecord(req, actor, delivery, outcome);
        }

        await auditRun(req, actor, summary);
        return summary;
    } finally {
        await releaseBulkLock(lock.ownerId);
    }
};

module.exports = {
    STOPPED_STATUS,
    RETRYABLE_KINDS,
    SUCCESS_STATUSES,
    EXCLUDED_STATUSES,
    DEFAULT_WINDOW,
    resolveBatchCap,
    resolveMaxAttempts,
    resolveThrottleMs,
    resolveWindow,
    ineligibilityReason,
    partitionCandidates,
    previewFailedRetries,
    retryFailedDeliveries,
    scopeListedDeliveries,
    deliveryFilterForTenant,
    countDeliveries
};
