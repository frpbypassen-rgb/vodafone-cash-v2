'use strict';

const DEFAULT_PHONE_LENGTHS = [3, 4, 11];
const PHONE_LENGTH_MODES = Object.freeze({
    3: [3],
    4: [4],
    11: [11],
    all: [3, 4, 11]
});
const DEFAULT_MAX_CONCURRENT_DEVICES = 1;
const MAX_CONCURRENT_DEVICES_CAP = 20;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 15 * 60;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OPEN_WEB_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const hasOwn = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)
    && object[key] !== undefined
    && object[key] !== null
    && object[key] !== '';

const normalizeAllowedPhoneLengths = (lengths) => {
    const normalized = (Array.isArray(lengths) ? lengths : DEFAULT_PHONE_LENGTHS)
        .map((value) => Number(value))
        .filter((value) => [3, 4, 11].includes(value));
    return normalized.length ? [...new Set(normalized)].sort((a, b) => a - b) : [...DEFAULT_PHONE_LENGTHS];
};

const phoneLengthModeFromLengths = (lengths) => {
    const normalized = normalizeAllowedPhoneLengths(lengths);
    const key = normalized.join(',');
    if (key === '3') return '3';
    if (key === '4') return '4';
    if (key === '11') return '11';
    return 'all';
};

const lengthsFromPhoneLengthMode = (mode, fallbackLengths) => {
    const key = String(mode || '').trim().toLowerCase();
    if (PHONE_LENGTH_MODES[key]) return [...PHONE_LENGTH_MODES[key]];
    return normalizeAllowedPhoneLengths(fallbackLengths);
};

const normalizeMaxConcurrentDevices = (value, fallback = DEFAULT_MAX_CONCURRENT_DEVICES) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(MAX_CONCURRENT_DEVICES_CAP, Math.max(1, Math.floor(parsed)));
};

const normalizeSessionTtlSeconds = (value, fallback = DEFAULT_SESSION_TTL_SECONDS) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(MAX_SESSION_TTL_SECONDS, Math.max(MIN_SESSION_TTL_SECONDS, Math.floor(parsed)));
};

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

const allowedLengthsLabel = (lengths) => normalizeAllowedPhoneLengths(lengths).join(' أو ');

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
            message: `طول رقم المرسل غير مسموح. الأطوال المسموحة: ${allowedLengthsLabel(lengths)} أرقام.`
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

const readCompanyExecutionPolicy = (group) => {
    const source = group && typeof group === 'object' ? group : {};
    const allowedPhoneLengths = normalizeAllowedPhoneLengths(source.manualAllowedPhoneLengths);
    const sessionTtlEnabled = Boolean(source.sessionTtlEnabled);
    return {
        proofRequired: Boolean(source.manualProofRequired),
        allowedPhoneLengths,
        phoneLengthMode: phoneLengthModeFromLengths(allowedPhoneLengths),
        splitRequiresFullPhone: source.manualSplitRequiresFullPhone !== false,
        maxConcurrentDevices: normalizeMaxConcurrentDevices(source.maxConcurrentDevices),
        sessionTtlEnabled,
        sessionTtlSeconds: sessionTtlEnabled
            ? normalizeSessionTtlSeconds(source.sessionTtlSeconds)
            : null
    };
};

const readExecutorManualPolicy = (group, employee = null) => {
    const company = readCompanyExecutionPolicy(group);
    const override = employee && typeof employee === 'object'
        ? (employee.executionPolicyOverride || {})
        : {};

    const allowedPhoneLengths = hasOwn(override, 'allowedPhoneLengths')
        && Array.isArray(override.allowedPhoneLengths)
        && override.allowedPhoneLengths.length
        ? normalizeAllowedPhoneLengths(override.allowedPhoneLengths)
        : company.allowedPhoneLengths;
    const sessionTtlEnabled = hasOwn(override, 'sessionTtlEnabled')
        ? Boolean(override.sessionTtlEnabled)
        : company.sessionTtlEnabled;
    const sessionTtlSeconds = sessionTtlEnabled
        ? normalizeSessionTtlSeconds(
            hasOwn(override, 'sessionTtlSeconds') ? override.sessionTtlSeconds : company.sessionTtlSeconds
        )
        : null;

    return {
        proofRequired: hasOwn(override, 'proofRequired') ? Boolean(override.proofRequired) : company.proofRequired,
        allowedPhoneLengths,
        phoneLengthMode: phoneLengthModeFromLengths(allowedPhoneLengths),
        splitRequiresFullPhone: company.splitRequiresFullPhone,
        maxConcurrentDevices: hasOwn(override, 'maxConcurrentDevices')
            ? normalizeMaxConcurrentDevices(override.maxConcurrentDevices)
            : company.maxConcurrentDevices,
        sessionTtlEnabled,
        sessionTtlSeconds,
        company,
        inherited: {
            proofRequired: !hasOwn(override, 'proofRequired'),
            allowedPhoneLengths: !(
                hasOwn(override, 'allowedPhoneLengths')
                && Array.isArray(override.allowedPhoneLengths)
                && override.allowedPhoneLengths.length
            ),
            maxConcurrentDevices: !hasOwn(override, 'maxConcurrentDevices'),
            sessionTtl: !hasOwn(override, 'sessionTtlEnabled') && !hasOwn(override, 'sessionTtlSeconds')
        }
    };
};

const toPublicExecutionPolicy = (policy) => ({
    proofRequired: Boolean(policy?.proofRequired),
    allowedPhoneLengths: normalizeAllowedPhoneLengths(policy?.allowedPhoneLengths),
    phoneLengthMode: phoneLengthModeFromLengths(policy?.allowedPhoneLengths),
    splitRequiresFullPhone: policy?.splitRequiresFullPhone !== false,
    maxConcurrentDevices: normalizeMaxConcurrentDevices(policy?.maxConcurrentDevices),
    sessionTtlEnabled: Boolean(policy?.sessionTtlEnabled),
    sessionTtlSeconds: policy?.sessionTtlEnabled
        ? normalizeSessionTtlSeconds(policy?.sessionTtlSeconds)
        : null,
    inherited: policy?.inherited || null
});

const serializeAllowedPhoneLengths = (body = {}) => {
    if (body.phoneLengthMode) {
        return lengthsFromPhoneLengthMode(body.phoneLengthMode, body.allowedPhoneLengths);
    }
    if (Array.isArray(body.allowedPhoneLengths) && body.allowedPhoneLengths.length) {
        return normalizeAllowedPhoneLengths(body.allowedPhoneLengths);
    }
    const selected = [];
    if (body.allowPhone3 === 'on' || body.allowPhone3 === true || body.allowPhone3 === '1') selected.push(3);
    if (body.allowPhone4 === 'on' || body.allowPhone4 === true || body.allowPhone4 === '1') selected.push(4);
    if (body.allowPhone11 === 'on' || body.allowPhone11 === true || body.allowPhone11 === '1') selected.push(11);
    return normalizeAllowedPhoneLengths(selected);
};

const parseBooleanFlag = (value) => {
    if (value === true || value === 'true' || value === 'on' || value === '1' || value === 1) return true;
    if (value === false || value === 'false' || value === 'off' || value === '0' || value === 0) return false;
    return null;
};

const serializeCompanyExecutionPolicy = (body = {}) => {
    const sessionTtlEnabled = parseBooleanFlag(body.sessionTtlEnabled) === true;
    const ttlSeconds = body.sessionTtlSeconds ?? (
        body.sessionTtlHours !== undefined && body.sessionTtlHours !== null && body.sessionTtlHours !== ''
            ? Number(body.sessionTtlHours) * 3600
            : undefined
    );
    return {
        manualProofRequired: parseBooleanFlag(body.proofRequired ?? body.manualProofRequired) === true,
        manualAllowedPhoneLengths: serializeAllowedPhoneLengths(body),
        manualSplitRequiresFullPhone: parseBooleanFlag(
            body.splitRequiresFullPhone ?? body.manualSplitRequiresFullPhone
        ) !== false,
        maxConcurrentDevices: normalizeMaxConcurrentDevices(body.maxConcurrentDevices),
        sessionTtlEnabled,
        sessionTtlSeconds: sessionTtlEnabled
            ? normalizeSessionTtlSeconds(ttlSeconds)
            : null
    };
};

const serializeEmployeePolicyOverride = (body = {}) => {
    const inheritAll = parseBooleanFlag(body.inheritCompanyPolicy);
    if (inheritAll === true) return {};

    const override = {};
    const inheritProof = parseBooleanFlag(body.inheritProofRequired);
    const inheritPhone = parseBooleanFlag(body.inheritPhoneLengths);
    const inheritDevices = parseBooleanFlag(body.inheritMaxConcurrentDevices);
    const inheritSession = parseBooleanFlag(body.inheritSessionTtl);

    if (inheritProof !== true && parseBooleanFlag(body.proofRequired) !== null) {
        override.proofRequired = parseBooleanFlag(body.proofRequired);
    }
    if (inheritPhone !== true && (body.phoneLengthMode || body.allowedPhoneLengths || body.allowPhone3 || body.allowPhone4 || body.allowPhone11)) {
        override.allowedPhoneLengths = serializeAllowedPhoneLengths(body);
    }
    if (inheritDevices !== true && body.maxConcurrentDevices !== undefined && body.maxConcurrentDevices !== null && body.maxConcurrentDevices !== '') {
        override.maxConcurrentDevices = normalizeMaxConcurrentDevices(body.maxConcurrentDevices);
    }
    if (inheritSession !== true && parseBooleanFlag(body.sessionTtlEnabled) !== null) {
        override.sessionTtlEnabled = parseBooleanFlag(body.sessionTtlEnabled);
        if (override.sessionTtlEnabled) {
            const ttlSeconds = body.sessionTtlSeconds ?? (
                body.sessionTtlHours !== undefined && body.sessionTtlHours !== null && body.sessionTtlHours !== ''
                    ? Number(body.sessionTtlHours) * 3600
                    : undefined
            );
            override.sessionTtlSeconds = normalizeSessionTtlSeconds(ttlSeconds);
        }
    }
    return override;
};

const webSessionMaxAgeMsForPolicy = (policy, fallbackMs) => {
    if (!policy?.sessionTtlEnabled) return OPEN_WEB_SESSION_MS;
    return normalizeSessionTtlSeconds(policy.sessionTtlSeconds) * 1000 || fallbackMs;
};

const absoluteSessionExpiresAtForPolicy = (policy, now = Date.now()) => {
    if (!policy?.sessionTtlEnabled) return 0;
    return now + (normalizeSessionTtlSeconds(policy.sessionTtlSeconds) * 1000);
};

module.exports = {
    DEFAULT_PHONE_LENGTHS,
    DEFAULT_MAX_CONCURRENT_DEVICES,
    DEFAULT_SESSION_TTL_SECONDS,
    OPEN_WEB_SESSION_MS,
    PHONE_LENGTH_MODES,
    absoluteSessionExpiresAtForPolicy,
    lengthsFromPhoneLengthMode,
    normalizeAllowedPhoneLengths,
    normalizeMaxConcurrentDevices,
    normalizeSessionTtlSeconds,
    phoneLengthModeFromLengths,
    readCompanyExecutionPolicy,
    readExecutorManualPolicy,
    serializeAllowedPhoneLengths,
    serializeCompanyExecutionPolicy,
    serializeEmployeePolicyOverride,
    toPublicExecutionPolicy,
    validateSenderPhoneDigits,
    webSessionMaxAgeMsForPolicy
};
