'use strict';

// Search input reaches the database only after it is classified and normalized
// here. Keeping this in one small module makes the web and mobile report
// endpoints behave identically and prevents user supplied regular expressions.
const ARABIC_DIGITS = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

const MAX_SEARCH_LENGTH = 64;
const MAX_SEARCH_AMOUNT = 1000000000;

const normalizeDigits = (value) => String(value || '')
    .replace(/[٠-٩۰-۹]/g, (digit) => ARABIC_DIGITS[digit] || digit)
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '');

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const numberPattern = (digits) => digits
    .split('')
    .map((digit) => `${escapeRegex(digit)}\\D*`)
    .join('');

const parseAmount = (rawValue) => {
    let value = normalizeDigits(rawValue).trim().toLowerCase();
    if (!value) return null;

    // Accept the most common Arabic/English currency suffixes without making
    // a phrase such as a reference code look like a monetary amount.
    value = value
        .replace(/(?:ج(?:\.?\s*م)?|جنيه(?:\s+مصري)?|مصري|egp)/giu, '')
        .replace(/\s+/g, '');
    if (!/^[0-9.,\u066b\u066c]+$/u.test(value)) return null;

    const separator = /[.,\u066b\u066c]/u;
    if (!separator.test(value)) {
        const amount = Number(value);
        return Number.isFinite(amount) && amount >= 0 && amount <= MAX_SEARCH_AMOUNT ? amount : null;
    }

    const parts = value.split(/[.,\u066b\u066c]/u);
    if (parts.some((part) => !/^\d+$/.test(part))) return null;
    const lastPart = parts.at(-1);
    // 2٫000 and 2,000 are routinely written as thousands in transfer notices.
    // A final group of 1-2 digits is treated as an actual decimal fraction.
    const hasDecimalFraction = lastPart.length > 0 && lastPart.length <= 2;
    const compact = hasDecimalFraction
        ? `${parts.slice(0, -1).join('')}.${lastPart}`
        : parts.join('');
    const amount = Number(compact);
    return Number.isFinite(amount) && amount >= 0 && amount <= MAX_SEARCH_AMOUNT ? amount : null;
};

const phoneSearchQuery = (digits) => {
    // Do not anchor this expression: a locally entered Egyptian number must
    // still find its E.164 (+20...) representation. Separators are tolerated.
    const expression = new RegExp(numberPattern(digits), 'i');
    return {
        $or: [
            { vodafoneNumber: expression },
            { accountNumber: expression },
            { canonicalRecipient: expression },
            { executorSenderPhone: expression },
            { 'executorSenderEntries.phone': expression },
            { 'serviceDetails.clientPhone': expression }
        ]
    };
};

const referenceSearchQuery = (value) => {
    const expression = new RegExp(escapeRegex(value), 'i');
    return {
        $or: [
            { customId: expression },
            { executorExecutionNumber: expression },
            { manualExecutorReceiptReference: expression }
        ]
    };
};

const buildExecutorOperationSearchQuery = (input) => {
    const normalized = normalizeDigits(input).trim().slice(0, MAX_SEARCH_LENGTH);
    if (!normalized) return { active: false, query: null, kind: null, value: null };

    const digitsOnly = normalized.replace(/\D/g, '');
    if (/^\d{9,15}$/.test(digitsOnly)) {
        return {
            active: true,
            query: phoneSearchQuery(digitsOnly),
            kind: 'phone',
            value: digitsOnly
        };
    }

    const amount = parseAmount(normalized);
    if (amount !== null) {
        const tolerance = 0.00001;
        return {
            active: true,
            query: { amount: { $gte: amount - tolerance, $lte: amount + tolerance } },
            kind: 'amount',
            value: amount
        };
    }

    return {
        active: true,
        query: referenceSearchQuery(normalized),
        kind: 'reference',
        value: normalized
    };
};

module.exports = {
    buildExecutorOperationSearchQuery,
    normalizeDigits,
    parseAmount
};
