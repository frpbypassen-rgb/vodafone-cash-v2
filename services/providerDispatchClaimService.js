'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

const UNRESOLVED_CODE = 'PROVIDER_RESULT_UNRESOLVED';
const DISPATCH_IN_PROGRESS_CODE = 'PROVIDER_DISPATCH_IN_PROGRESS';
const EXECUTABLE_DISPATCH_STATUSES = ['accepted', 'processing'];
// pending_reference is an HTTP 200 acceptance without a reference number.
// It is not a settled result: the provider may have paid, so money guards
// treat it like an unresolved dispatch. accepted and rejected are settled.
const DEFINITIVE_DISPATCH_RESULTS = new Set(['accepted', 'rejected']);
const BEFORE_SEND_CODES = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'EAI_NODATA',
    'ECONNREFUSED',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EADDRNOTAVAIL'
]);

const appendNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    if (String(current || '').includes(cleanNote)) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

const dataOf = (tx) => (tx && tx.apiResultData) || {};

const asObjectId = (value) => {
    if (!value) return value;
    if (value instanceof mongoose.Types.ObjectId) return value;
    const raw = String(value);
    return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : value;
};

const updatedDocument = (result) => {
    if (!result) return null;
    if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value || null;
    return result;
};

const hasDispatchMarker = (tx) => {
    const data = dataOf(tx);
    return Boolean(data.providerDispatchStartedAt)
        || Boolean(String(data.providerDispatchAttemptId || '').trim());
};

const hasDefinitiveProviderResult = (tx) => {
    const data = dataOf(tx);
    const result = String(data.providerDispatchResult || '');
    if (DEFINITIVE_DISPATCH_RESULTS.has(result)) return true;
    if (data.waitingApiAutoCompletion === true && String(data.referenceNumber || '').trim()) return true;
    if (tx && tx.status === 'completed' && String(data.referenceNumber || '').trim()) return true;
    return false;
};

const isProviderResultUnresolved = (tx) => dataOf(tx).providerResultUnresolved === true;

const needsUnresolvedHold = (tx) => Boolean(
    tx
    && hasDispatchMarker(tx)
    && !hasDefinitiveProviderResult(tx)
    && !isProviderResultUnresolved(tx)
);

const resolutionOutcome = (tx) => String(dataOf(tx).providerResolutionOutcome || '');

// Money hold: do not refund, re-send, or return the row to the assignable pool.
// Reuses providerResultUnresolved rather than a second flag. pending_reference
// is also a hold even if that flag was not written, because HTTP 200 without a
// reference still means the provider may have accepted the transfer.
const providerMoneyHold = (tx) => {
    if (!tx) return false;
    const outcome = resolutionOutcome(tx);
    if (outcome === 'provider_not_paid' && tx.status === 'pending' && !isProviderResultUnresolved(tx)) return false;
    if (outcome === 'provider_paid' && tx.status === 'completed') return false;
    if (isProviderResultUnresolved(tx) || needsUnresolvedHold(tx)) return true;
    if (String(dataOf(tx).providerDispatchResult || '') === 'pending_reference') return true;
    return outcome === 'provider_paid' || outcome === 'provider_not_paid';
};

// Blocks another Payment. A recorded rejection is retryable once the in-flight
// marker has been released. Accepted, pending-reference, unresolved, and
// marker-without-result rows are not.
const automaticPaymentBlocked = (tx) => {
    if (!tx) return false;
    if (providerMoneyHold(tx)) return true;
    if (!hasDispatchMarker(tx)) return false;
    const result = String(dataOf(tx).providerDispatchResult || '');
    return result === 'accepted' || result === 'pending_reference';
};

const unresolvedHoldMessage = () => (
    'لا يمكن إلغاء العملية مع الاسترجاع: نتيجة المزود غير محسومة. يجب مراجعتها يدوياً قبل أي استرجاع أو إعادة إرسال.'
);

const refundBlockedByUnresolvedProvider = (tx) => {
    if (!providerMoneyHold(tx)) return null;
    return {
        success: false,
        statusCode: 409,
        code: UNRESOLVED_CODE,
        message: unresolvedHoldMessage()
    };
};

const classifyPaymentTransportError = (error) => {
    const status = Number(error && error.response && error.response.status);
    if (status >= 500) return 'unresolved';
    if (status >= 400 && status < 500) return 'definitive_rejection';
    const code = String(error && error.code || '');
    if (!(error && error.response) && BEFORE_SEND_CODES.has(code)) return 'before_send';
    return 'unresolved';
};

const applyClaimToDoc = (tx, { attemptId, claimedAt }) => {
    if (!tx) return;
    tx.apiResultData = {
        ...(tx.apiResultData || {}),
        providerDispatchStartedAt: claimedAt,
        providerDispatchAttemptId: attemptId,
        providerDispatchExecutorGroupId: tx.executorGroupId || null
    };
    if (typeof tx.markModified === 'function') tx.markModified('apiResultData');
};

const clearClaimOnDoc = (tx) => {
    if (!tx || !tx.apiResultData) return;
    const next = { ...tx.apiResultData };
    delete next.providerDispatchStartedAt;
    delete next.providerDispatchAttemptId;
    delete next.providerDispatchExecutorGroupId;
    tx.apiResultData = next;
    if (typeof tx.markModified === 'function') tx.markModified('apiResultData');
};

const claimProviderDispatch = async (tx, options = {}) => {
    const groupId = options.executorGroupId || (tx && tx.executorGroupId);
    if (!tx || !tx._id || !groupId) {
        return { claimed: false, reason: 'missing_transaction' };
    }
    const statuses = Array.isArray(options.statuses) && options.statuses.length
        ? options.statuses
        : ['processing'];
    const attemptId = crypto.randomUUID();
    const claimedAt = new Date();
    try {
        const result = await Transaction.collection.findOneAndUpdate(
            {
                _id: asObjectId(tx._id),
                status: { $in: statuses },
                executorGroupId: asObjectId(groupId),
                'apiResultData.providerResultUnresolved': { $ne: true },
                'apiResultData.providerDispatchResult': { $nin: ['accepted', 'pending_reference'] },
                $and: [
                    {
                        $or: [
                            { 'apiResultData.providerDispatchStartedAt': { $exists: false } },
                            { 'apiResultData.providerDispatchStartedAt': null }
                        ]
                    },
                    {
                        $or: [
                            { 'apiResultData.providerDispatchAttemptId': { $exists: false } },
                            { 'apiResultData.providerDispatchAttemptId': null },
                            { 'apiResultData.providerDispatchAttemptId': '' }
                        ]
                    }
                ]
            },
            {
                $set: {
                    'apiResultData.providerDispatchStartedAt': claimedAt,
                    'apiResultData.providerDispatchAttemptId': attemptId,
                    'apiResultData.providerDispatchExecutorGroupId': asObjectId(groupId),
                    updatedAt: claimedAt
                }
            },
            { returnDocument: 'after', writeConcern: { w: 'majority' } }
        );
        const claimed = updatedDocument(result);
        if (!claimed) return { claimed: false, reason: 'claim_lost', attemptId };
        applyClaimToDoc(tx, { attemptId, claimedAt });
        return { claimed: true, attemptId, claimedAt };
    } catch (error) {
        logger.error('Provider dispatch claim failed closed', {
            txId: String(tx._id),
            error: error.message
        });
        return { claimed: false, reason: 'claim_error', attemptId, error };
    }
};

const releaseProviderDispatchClaim = async (tx, attemptId, options = {}) => {
    clearClaimOnDoc(tx);
    if (!tx || !tx._id || !attemptId || !Transaction.collection) return { released: false };
    const statuses = Array.isArray(options.statuses) && options.statuses.length
        ? options.statuses
        : ['processing'];
    const write = await Transaction.collection.updateOne(
        {
            _id: asObjectId(tx._id),
            status: { $in: statuses },
            'apiResultData.providerDispatchAttemptId': attemptId,
            'apiResultData.providerResultUnresolved': { $ne: true },
            'apiResultData.providerDispatchResult': { $nin: ['accepted', 'pending_reference'] }
        },
        {
            $unset: {
                'apiResultData.providerDispatchStartedAt': '',
                'apiResultData.providerDispatchAttemptId': '',
                'apiResultData.providerDispatchExecutorGroupId': ''
            },
            $set: { updatedAt: new Date() }
        }
    );
    return { released: write.matchedCount === 1 || write.modifiedCount === 1 };
};

// Keeps the dispatch marker and records a provider outcome that must not be
// paid again. Used for timeout/unknown results and for a provider acceptance
// whose local debit/completion transaction did not commit.
const recordProviderDispatchHold = async ({
    txId,
    attemptId,
    result,
    reason,
    referenceNumber,
    transactionNumber,
    statuses = EXECUTABLE_DISPATCH_STATUSES
} = {}) => {
    if (!txId || !attemptId || !result) return { marked: false, reason: 'missing' };
    if (mongoose.connection.readyState !== 1) return { marked: false, reason: 'not_connected' };
    const current = await Transaction.findById(txId);
    if (!current || !statuses.includes(current.status)) return { marked: false, reason: 'not_holdable' };
    if (String(dataOf(current).providerDispatchAttemptId || '') !== String(attemptId)) {
        return { marked: false, reason: 'attempt_mismatch' };
    }
    const existingResult = String(dataOf(current).providerDispatchResult || '');
    if (existingResult === 'accepted' && result !== 'accepted') {
        return { marked: true, already: true };
    }
    const now = new Date();
    const reference = String(referenceNumber || '').trim();
    const providerTransactionNumber = String(transactionNumber || '').trim();
    const note = result === 'accepted'
        ? `[ZaynPay provider reference held | Ref: ${reference || '—'} | TxNo: ${providerTransactionNumber || '—'} | local completion did not commit]`
        : `[PROVIDER_RESULT_UNRESOLVED] نتيجة المزود غير محسومة: ${String(reason || 'unknown').slice(0, 300)}. لا إعادة إرسال ولا استرجاع حتى المراجعة اليدوية.`;
    const set = {
        updatedAt: now,
        adminNotes: appendNoteText(current.adminNotes, note),
        'apiResultData.providerDispatchResult': result,
        'apiResultData.providerResultUnresolved': true,
        'apiResultData.providerResultUnresolvedAt': now,
        'apiResultData.providerResultUnresolvedReason': String(reason || '').slice(0, 500),
        'apiResultData.providerResultUnresolvedCode': UNRESOLVED_CODE
    };
    if (reference) set['apiResultData.referenceNumber'] = reference.slice(0, 200);
    if (providerTransactionNumber) set['apiResultData.providerTransactionNumber'] = providerTransactionNumber.slice(0, 200);
    const write = await Transaction.collection.updateOne(
        {
            _id: asObjectId(current._id),
            status: { $in: statuses },
            'apiResultData.providerDispatchAttemptId': attemptId
        },
        { $set: set }
    );
    return { marked: write.matchedCount === 1 || write.modifiedCount === 1 };
};

const markProviderResultUnresolved = async ({ txId, reason, source } = {}) => {
    if (!txId || mongoose.connection.readyState !== 1) return { marked: false, reason: 'not_connected' };
    const current = await Transaction.findById(txId);
    if (!current || current.status !== 'processing') return { marked: false, reason: 'not_processing' };
    if (hasDefinitiveProviderResult(current)) return { marked: false, reason: 'definitive_result' };
    if (!hasDispatchMarker(current)) return { marked: false, reason: 'no_marker' };
    if (isProviderResultUnresolved(current)) return { marked: true, already: true };

    const note = `[PROVIDER_RESULT_UNRESOLVED] نتيجة المزود غير محسومة (${source || 'api'}): ${String(reason || 'unknown').slice(0, 300)}. لا إعادة إرسال ولا استرجاع حتى المراجعة اليدوية.`;
    const now = new Date();
    const write = await Transaction.collection.updateOne(
        {
            _id: asObjectId(current._id),
            status: 'processing',
            'apiResultData.providerDispatchAttemptId': current.apiResultData.providerDispatchAttemptId,
            'apiResultData.providerDispatchResult': { $nin: ['accepted', 'rejected'] }
        },
        {
            $set: {
                status: 'processing',
                adminNotes: appendNoteText(current.adminNotes, note),
                updatedAt: now,
                'apiResultData.providerResultUnresolved': true,
                'apiResultData.providerResultUnresolvedAt': now,
                'apiResultData.providerResultUnresolvedReason': String(reason || '').slice(0, 500),
                'apiResultData.providerResultUnresolvedCode': UNRESOLVED_CODE
            }
        }
    );
    return { marked: write.modifiedCount === 1 || write.matchedCount === 1 };
};

const guardAutomaticProviderRedispatch = async (txId) => {
    if (!txId) return { handled: false, reason: 'missing_id' };
    if (mongoose.connection.readyState !== 1) return { handled: false, reason: 'not_connected' };

    let tx;
    try {
        tx = await Transaction.findById(txId);
    } catch (error) {
        logger.warn('Provider dispatch guard skipped lookup', { txId: String(txId), error: error.message });
        return { handled: false, reason: 'lookup_failed' };
    }
    if (!tx) return { handled: false, reason: 'missing' };

    if (needsUnresolvedHold(tx)) {
        await markProviderResultUnresolved({
            txId: tx._id,
            reason: 'dispatch marker without a definitive provider result',
            source: 'automatic-redispatch-guard'
        });
        return { handled: true, reason: 'in_flight_dispatch', code: UNRESOLVED_CODE };
    }
    if (isProviderResultUnresolved(tx)) {
        return { handled: true, reason: 'unresolved', code: UNRESOLVED_CODE };
    }
    if (automaticPaymentBlocked(tx)) {
        return { handled: true, reason: 'provider_already_dispatched', code: UNRESOLVED_CODE };
    }
    return { handled: false, reason: 'clear' };
};

const unresolvedProviderResultFilter = () => ({
    $or: [
        { 'apiResultData.providerResultUnresolved': true },
        {
            status: 'processing',
            'apiResultData.providerDispatchStartedAt': { $type: 'date' },
            $nor: [
                { 'apiResultData.providerDispatchResult': { $in: ['accepted', 'rejected'] } }
            ]
        }
    ]
});

const listUnresolvedProviderResults = async ({ limit = 100 } = {}) => {
    const filter = unresolvedProviderResultFilter();
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const [count, rows] = await Promise.all([
        Transaction.countDocuments(filter),
        Transaction.find(filter)
            .sort({ updatedAt: -1 })
            .limit(capped)
            .select('customId status amount executorGroupId executorName adminNotes apiResultData createdAt updatedAt')
            .lean()
    ]);
    return {
        count,
        limit: capped,
        rows: rows.map((row) => ({
            id: String(row._id),
            customId: row.customId,
            status: row.status,
            amount: row.amount,
            executorGroupId: row.executorGroupId ? String(row.executorGroupId) : null,
            executorName: row.executorName || '',
            providerResultUnresolved: row.apiResultData && row.apiResultData.providerResultUnresolved === true,
            providerResultUnresolvedAt: row.apiResultData && row.apiResultData.providerResultUnresolvedAt || null,
            providerResultUnresolvedReason: row.apiResultData && row.apiResultData.providerResultUnresolvedReason || '',
            providerDispatchStartedAt: row.apiResultData && row.apiResultData.providerDispatchStartedAt || null,
            providerDispatchAttemptId: row.apiResultData && row.apiResultData.providerDispatchAttemptId || '',
            providerDispatchResult: row.apiResultData && row.apiResultData.providerDispatchResult || ''
        }))
    };
};

module.exports = {
    UNRESOLVED_CODE,
    DISPATCH_IN_PROGRESS_CODE,
    EXECUTABLE_DISPATCH_STATUSES,
    hasDispatchMarker,
    hasDefinitiveProviderResult,
    isProviderResultUnresolved,
    needsUnresolvedHold,
    providerMoneyHold,
    automaticPaymentBlocked,
    refundBlockedByUnresolvedProvider,
    classifyPaymentTransportError,
    claimProviderDispatch,
    releaseProviderDispatchClaim,
    recordProviderDispatchHold,
    clearClaimOnDoc,
    markProviderResultUnresolved,
    guardAutomaticProviderRedispatch,
    unresolvedProviderResultFilter,
    listUnresolvedProviderResults
};
