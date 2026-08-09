'use strict';

const crypto = require('crypto');

const PLACEHOLDER_HOSTS = new Set(['your-production-domain.example', 'example.com']);

const getReceiptShareSecret = () => String(process.env.RECEIPT_SHARE_SECRET || '').trim();

const getPublicAppUrl = () => {
    const rawUrl = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
    if (!rawUrl) return null;

    try {
        const url = new URL(rawUrl);
        if (url.protocol !== 'https:' || PLACEHOLDER_HOSTS.has(url.hostname)) return null;
        return url.toString().replace(/\/+$/, '');
    } catch (_) {
        return null;
    }
};

const getReceiptUrlTtlHours = () => {
    const configured = Number(process.env.WHATCHIMP_RECEIPT_URL_TTL_HOURS);
    if (!Number.isFinite(configured)) return 24 * 30;
    return Math.min(Math.max(configured, 1), 24 * 90);
};

const signReceiptAccess = ({ transactionId, index, expires }) => {
    const secret = getReceiptShareSecret();
    if (!secret) return null;
    return crypto
        .createHmac('sha256', secret)
        .update(`${transactionId}:${index}:${expires}`)
        .digest('hex');
};

const createReceiptImageUrl = ({ transactionId, index = 0, expiresAt } = {}) => {
    const publicUrl = getPublicAppUrl();
    const id = String(transactionId || '').trim();
    const safeIndex = Number(index);
    if (!publicUrl || !id || !Number.isInteger(safeIndex) || safeIndex < 0) return null;

    const expires = Number(expiresAt || (Date.now() + (getReceiptUrlTtlHours() * 60 * 60 * 1000)));
    if (!Number.isFinite(expires)) return null;
    const signature = signReceiptAccess({ transactionId: id, index: safeIndex, expires });
    if (!signature) return null;

    const query = new URLSearchParams({
        index: String(safeIndex),
        expires: String(Math.floor(expires)),
        signature
    });
    return `${publicUrl}/public/receipt/${encodeURIComponent(id)}/image?${query.toString()}`;
};

const verifyReceiptAccess = ({ transactionId, index, expires, signature } = {}) => {
    const id = String(transactionId || '').trim();
    const safeIndex = Number(index);
    const expiry = Number(expires);
    const supplied = String(signature || '').trim();
    if (!id || !Number.isInteger(safeIndex) || safeIndex < 0 || !Number.isFinite(expiry) || !supplied) return false;
    if (expiry < Date.now() || expiry > Date.now() + (24 * 90 * 60 * 60 * 1000)) return false;

    const expected = signReceiptAccess({ transactionId: id, index: safeIndex, expires: Math.floor(expiry) });
    if (!expected) return false;
    const expectedBuffer = Buffer.from(expected);
    const suppliedBuffer = Buffer.from(supplied);
    return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
};

module.exports = {
    createReceiptImageUrl,
    getPublicAppUrl,
    getReceiptShareSecret,
    verifyReceiptAccess
};
