'use strict';

const SECRET_KEY_RE = /(?:password|passcode|otp|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|signature|credential|fingerprint)/i;
const IDENTIFIER_KEY_RE = /(?:phone|mobile|vodafone|recipient|sender|execution[_-]?number|national[_-]?id|account[_-]?(?:number|no)|userId)/i;

const maskIdentifier = (value) => {
    const text = String(value ?? '');
    const digits = text.replace(/\D/g, '');
    if (digits.length < 7) return text;
    return `${digits.slice(0, 3)}${'*'.repeat(Math.max(3, digits.length - 5))}${digits.slice(-2)}`;
};

const sanitizeLogValue = (value, key = '', depth = 0, seen = new WeakSet()) => {
    if (SECRET_KEY_RE.test(key)) return '[REDACTED]';
    if (IDENTIFIER_KEY_RE.test(key) && (typeof value === 'string' || typeof value === 'number')) {
        return maskIdentifier(value);
    }
    if (value === null || value === undefined || depth >= 6) return value;
    if (typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            code: value.code
        };
    }
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => sanitizeLogValue(item, key, depth + 1, seen));
    }

    return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            sanitizeLogValue(childValue, childKey, depth + 1, seen)
        ])
    );
};

const sanitizeLogInfo = (info) => {
    for (const key of Object.keys(info)) {
        if (key === 'level' || key === 'message' || key === 'timestamp' || key === 'service') continue;
        info[key] = sanitizeLogValue(info[key], key);
    }
    return info;
};

module.exports = {
    maskIdentifier,
    sanitizeLogInfo,
    sanitizeLogValue
};
