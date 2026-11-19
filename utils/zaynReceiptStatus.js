'use strict';

const { normalizeProviderStatus, booleanFlag } = require('./providerPaymentResponse');
const { providerOperationMatches } = require('./providerPendingOperation');

// Match whole states: "refund pending", "unsuccessful" and unknown status text
// must not be turned into a terminal receipt by a substring or a reference mask.
const terminalStates = new Map();
for (const [state, labels] of Object.entries({
    paid: ['paid','success','successful','completed','عملية ناجحة','ناجحة','تم الدفع بنجاح','تم التنفيذ بنجاح'],
    returned: ['refunded','reversed','returned','cancelled','canceled','عملية مسترجعة','مرتجعة','مسترجعة','عملية ملغاة','ملغاة','ملغية'],
    rejected: ['failed','rejected','declined','عملية فاشلة','عملية مرفوضة','فاشلة','مرفوضة']
})) {
    for (const label of labels) terminalStates.set(normalizeProviderStatus(label), state);
}

const classifyZaynReceiptStatus = value => terminalStates.get(normalizeProviderStatus(value)) || 'pending';
const isFinalZaynState = state => ['paid', 'returned', 'rejected'].includes(state);
const reversalStates = new Set(['refunded','reversed','returned','عملية مسترجعة','مرتجعة','مسترجعة'].map(normalizeProviderStatus));
const explicitlyReversed = value => reversalStates.has(normalizeProviderStatus(value));

function zaynReceiptObservation(tx, result) {
    if (!result.success) return 'failed';
    if (!result.reportedTransactionId || String(result.reportedTransactionId) !== String(tx.apiResultData.providerTransactionId)
        || !providerOperationMatches(tx, result)) return 'mismatch';
    const state = classifyZaynReceiptStatus(result.providerStatus);
    const details = result.rawData || {};
    const paid = booleanFlag(details.IsPaid);
    const failed = booleanFlag(details.IsFailure);
    if ((details.IsPaid != null && paid === null) || (details.IsFailure != null && failed === null)
        || (state === 'paid' && (failed === true || paid === false)) || (state === 'rejected' && paid === true)) return 'mismatch';
    return state;
}

function matchedZaynReceiptFields(result, state, checkedAt) {
    // Keep an allowlisted outcome even if provider status text contains free-form diagnostic data.
    const reference = String(result.referenceNumber || '').trim();
    return {providerMatchedAt:checkedAt, providerMatchedState:state, providerReportedStatus:state,
        providerReportedReference:/^[\w.*×＊•·/-]{1,160}$/u.test(reference) ? reference : '',
        providerReportedPhone:result.phone, providerReportedAmount:result.amount,
        ...(state === 'paid' ? {providerMatchedPaidAt:checkedAt} : {}),
        providerMatchedReversal:state === 'returned' && explicitlyReversed(result.providerStatus),
        ...(state === 'returned' ? {providerReturnDetectedAt:checkedAt} : {})};
}

function zaynAccountMatches(tx, group) {
    const data = tx.apiResultData;
    return Boolean(group && (group.isApiBot || group.isApiGroup) && group.status !== 'archived'
        && ['zayn_external_aggregator', 'zaynpay_legacy'].includes(group.apiProviderKey)
        && String(tx.tenantId || '') === String(group.tenantId || '')
        && data.zaynFollowupAttemptId && data.zaynFollowupAttemptId === data.providerDispatchAttemptId
        && String(data.providerDispatchExecutorGroupId || '') === String(group._id));
}

module.exports = { classifyZaynReceiptStatus, isFinalZaynState, explicitlyReversed, zaynReceiptObservation, matchedZaynReceiptFields, zaynAccountMatches };
