'use strict';

const ACTIVE_STATUSES = ['pending', 'processing', 'accepted'];
const providerTransactionIdOf = (tx) => {
    const data = tx?.apiResultData || {};
    return String(data.externalTransactionId || data.providerTransactionId
        || data.providerTransactionNumber || data.transactionNumber || '').trim();
};

// Older API rows may have a dispatch marker or provider number without the
// newer unresolved flags. Terminal rows and ordinary manual tasks stay out.
const canReviewProviderOperation = (tx) => {
    if (!tx || !ACTIVE_STATUSES.includes(tx.status) || tx.transferType === 'balance_transfer') return false;
    const data = tx.apiResultData || {};
    if (data.providerResolutionOutcome || data.providerDispatchResult === 'rejected') return false;
    const dispatchAt = new Date(data.providerDispatchStartedAt || tx.updatedAt).getTime();
    const staleDispatch = (data.providerDispatchStartedAt || data.providerDispatchAttemptId)
        && Number.isFinite(dispatchAt) && Date.now() - dispatchAt >= 5 * 60 * 1000;
    return Boolean(data.providerResultUnresolved === true
        || data.providerDispatchResult === 'pending_reference'
        || staleDispatch
        || data.waitingApiAutoCompletion === true
        || providerTransactionIdOf(tx)
        || (data.referenceMasked === false && data.referenceNumber));
};

const normalizePhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (/^002001\d{9}$/.test(digits)) return digits.slice(4);
    if (/^2001\d{9}$/.test(digits)) return digits.slice(2);
    if (/^201\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
    if (/^00201\d{9}$/.test(digits)) return `0${digits.slice(4)}`;
    return digits;
};

// A masked reference alone must not settle a different recipient/amount.
const providerOperationMatches = (tx, operation) => {
    const expectedPhone = normalizePhone(tx.vodafoneNumber || tx.accountNumber);
    const actualPhone = normalizePhone(operation.phone);
    const expectedId = providerTransactionIdOf(tx);
    const actualId = String(operation.providerTransactionId || '').trim();
    return Boolean(expectedId && actualId === expectedId && expectedPhone && actualPhone === expectedPhone
        && operation.amount != null && Number.isFinite(Number(operation.amount))
        && Math.abs(Number(operation.amount) - Number(tx.amount)) < 0.005);
};

const pendingProviderQuery = (now = new Date(), minimumAgeMs = 300000) => ({
    status: { $in: ACTIVE_STATUSES },
    transferType: { $ne: 'balance_transfer' },
    createdAt: { $lte: new Date(now.getTime() - minimumAgeMs) },
    'apiResultData.providerResolutionOutcome': { $in: [null, ''] },
    'apiResultData.providerDispatchResult': { $ne: 'rejected' },
    $or: [
        { 'apiResultData.providerResultUnresolved': true },
        { 'apiResultData.providerDispatchResult': 'pending_reference' },
        { 'apiResultData.waitingApiAutoCompletion': true },
        ...['providerDispatchStartedAt', 'providerDispatchAttemptId', 'externalTransactionId',
            'providerTransactionId', 'providerTransactionNumber', 'transactionNumber'].map((key) => ({
            [`apiResultData.${key}`]: { $exists: true, $nin: [null, ''] }
        })),
        { 'apiResultData.referenceMasked': false, 'apiResultData.referenceNumber': { $exists: true, $nin: [null, ''] } }
    ]
});

module.exports = { ACTIVE_STATUSES, canReviewProviderOperation, providerTransactionIdOf, providerOperationMatches, pendingProviderQuery };
