'use strict';

const normalizeProviderStatus = (value) => String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();

const isReturnedProviderStatus = (value) => {
    const status = normalizeProviderStatus(value);
    if (!status) return false;
    return [
        'استرجاع',
        'مسترجع',
        'مسترد',
        'مرتجع',
        'مرتد',
        'مردود',
        'معكوس',
        'تم رد',
        'ملغ',
        'الغاء',
        'refund',
        'revers',
        'return',
        'cancel'
    ].some((marker) => status.includes(marker));
};

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const booleanFlag = value => {
    if (value === true || value === 1 || String(value).toLowerCase() === 'true' || value === '1') return true;
    if (value === false || value === 0 || String(value).toLowerCase() === 'false' || value === '0') return false;
    return null;
};
const reference = value => ['string', 'number'].includes(typeof value) && String(value).trim() !== '';

// A malformed or contradictory response after Payment cannot prove non-payment.
const classifyProviderPaymentResponse = (response, { returned = false } = {}) => {
    if (!object(response) || returned) return 'unresolved';
    const data = object(response.Data) ? response.Data : {};
    if (isReturnedProviderStatus(data.Status || data.TransactionStatus || response.Message)) return 'unresolved';
    const print = object(data.PrintBill) ? data.PrintBill : {};
    const hasReference = [data.TransactionNumber, data.TransactionId, data.RefTransactionNumber,
        data.RefNumber, data.ApprovalNumber, print.TransactionId, print.RefTransactionNumber, print.RefNumber].some(reference);
    const failure = booleanFlag(data.IsFailure);
    const paid = booleanFlag(data.IsPaid);
    const code = typeof response.Code === 'number' || /^\d+$/.test(String(response.Code || '').trim())
        ? Number(response.Code) : null;
    const acceptanceEvidence = hasReference || paid === true;
    const explicitRejection = failure === true || (code >= 400 && code < 500 && ![408, 409, 425, 429].includes(code));
    if (acceptanceEvidence && (explicitRejection || paid === false)) return 'unresolved';
    if ((data.IsPaid != null && paid === null) || (data.IsFailure != null && failure === null)) return 'unresolved';
    if (explicitRejection) return 'rejected';
    if (code === 200 && object(response.Data) && acceptanceEvidence) return 'accepted';
    return 'unresolved';
};

module.exports = { classifyProviderPaymentResponse, normalizeProviderStatus, isReturnedProviderStatus };
