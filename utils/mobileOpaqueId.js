'use strict';

const crypto = require('crypto');

const OPAQUE_ID_PREFIX = 'mob';
const SECRET =
    process.env.MOBILE_API_ID_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    'development-only-mobile-api-secret';

const toBase64Url = (value) => Buffer.from(String(value), 'utf8').toString('base64url');

const fromBase64Url = (value) => Buffer.from(String(value), 'base64url').toString('utf8');

const sign = (value) =>
    crypto.createHmac('sha256', SECRET).update(String(value)).digest('base64url');

const timingSafeEqual = (left, right) => {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const encodeOpaqueId = (type, id) => {
    if (id === undefined || id === null || id === '') return '';
    const payload = toBase64Url(`${type}:${String(id)}`);
    return `${OPAQUE_ID_PREFIX}_${payload}.${sign(payload)}`;
};

const decodeOpaqueId = (expectedType, value) => {
    const rawValue = String(value || '').trim();
    if (!rawValue) throw new Error('INVALID_OPAQUE_ID');

    // Backward compatible input only. Responses must still emit opaque ids.
    if (!rawValue.startsWith(`${OPAQUE_ID_PREFIX}_`)) return rawValue;

    const encoded = rawValue.slice(OPAQUE_ID_PREFIX.length + 1);
    const [payload, signature] = encoded.split('.');
    if (!payload || !signature || !timingSafeEqual(signature, sign(payload))) {
        throw new Error('INVALID_OPAQUE_ID');
    }

    const decoded = fromBase64Url(payload);
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex <= 0) throw new Error('INVALID_OPAQUE_ID');

    const type = decoded.slice(0, separatorIndex);
    const id = decoded.slice(separatorIndex + 1);
    if (type !== expectedType || !id) throw new Error('INVALID_OPAQUE_ID');

    return id;
};

const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((acc, key) => {
                if (value[key] !== undefined) acc[key] = canonicalize(value[key]);
                return acc;
            }, {});
    }
    return value;
};

const buildRequestFingerprint = (scope, payload) =>
    crypto
        .createHmac('sha256', SECRET)
        .update(`${scope}:${JSON.stringify(canonicalize(payload))}`)
        .digest('hex');

module.exports = {
    encodeOpaqueId,
    decodeOpaqueId,
    buildRequestFingerprint
};
