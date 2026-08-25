'use strict';

const DEFAULT_PHONE_LENGTHS = [3, 4, 11];

const normalizeAllowedPhoneLengths = (lengths) => {
    const normalized = (Array.isArray(lengths) ? lengths : DEFAULT_PHONE_LENGTHS)
        .map((value) => Number(value))
        .filter((value) => [3, 4, 11].includes(value));
    return normalized.length ? [...new Set(normalized)].sort((a, b) => a - b) : [...DEFAULT_PHONE_LENGTHS];
};

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

const validateSenderPhoneDigits = (phone, { allowedPhoneLengths, splitRequiresFullPhone, isSplit }) => {
    const digits = digitsOnly(phone);
    if (!digits) {
        return { ok: false, code: 'INVALID_SENDER_PHONE', message: 'رقم المرسل مطلوب.' };
    }

    if (isSplit && splitRequiresFullPhone) {
        if (!/^01\d{9}$/.test(digits)) {
            return {
                ok: false,
                code: 'INVALID_SENDER_PHONE',
                message: 'عند تقسيم العملية يجب إدخال رقم الهاتف كاملاً (11 رقماً).'
            };
        }
        return { ok: true, digits };
    }

    const lengths = normalizeAllowedPhoneLengths(allowedPhoneLengths);
    if (!lengths.includes(digits.length)) {
        return {
            ok: false,
            code: 'INVALID_SENDER_PHONE',
            message: `طول رقم المرسل غير مسموح. الأطوال المسموحة: ${lengths.join(' أو ')} أرقام.`
        };
    }

    if (digits.length === 11 && !/^01\d{9}$/.test(digits)) {
        return {
            ok: false,
            code: 'INVALID_SENDER_PHONE',
            message: 'رقم الهاتف الكامل يجب أن يبدأ بـ 01 ويتكون من 11 رقماً.'
        };
    }

    return { ok: true, digits };
};

const readExecutorManualPolicy = (group) => {
    const source = group && typeof group === 'object' ? group : {};
    return {
        proofRequired: Boolean(source.manualProofRequired),
        allowedPhoneLengths: normalizeAllowedPhoneLengths(source.manualAllowedPhoneLengths),
        splitRequiresFullPhone: source.manualSplitRequiresFullPhone !== false
    };
};

const serializeAllowedPhoneLengths = (body = {}) => {
    const selected = [];
    if (body.allowPhone3 === 'on' || body.allowPhone3 === true || body.allowPhone3 === '1') selected.push(3);
    if (body.allowPhone4 === 'on' || body.allowPhone4 === true || body.allowPhone4 === '1') selected.push(4);
    if (body.allowPhone11 === 'on' || body.allowPhone11 === true || body.allowPhone11 === '1') selected.push(11);
    return normalizeAllowedPhoneLengths(selected);
};

module.exports = {
    DEFAULT_PHONE_LENGTHS,
    normalizeAllowedPhoneLengths,
    validateSenderPhoneDigits,
    readExecutorManualPolicy,
    serializeAllowedPhoneLengths
};
