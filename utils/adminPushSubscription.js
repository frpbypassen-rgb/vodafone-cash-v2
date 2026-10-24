'use strict';
const { ECDH } = require('crypto');
const invalid = () => { throw new Error('INVALID_ADMIN_PUSH_SUBSCRIPTION'); };
const normalizeAdminPushSubscription = input => {
    const raw = input?.endpoint;
    if (typeof raw !== 'string' || raw.length > 4096 || !/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/|\?|$)/i.test(raw)
        || /[\s\\#]/.test(raw)) return invalid();
    const url = new URL(raw);
    const host = url.hostname;
    // Chromium also uses this exact Google endpoint in staging/embedded builds.
    const allowed = ['fcm.googleapis.com', 'jmt17.google.com', 'updates.push.services.mozilla.com'].includes(host)
        || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:push\.apple\.com|notify\.windows\.com|wns\.windows\.com)$/.test(host);
    if (!allowed || url.username || url.password || url.hash || (url.port && url.port !== '443')) return invalid();
    const decode = (value, bytes) => {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > Math.ceil(bytes / 3) * 4) return invalid();
        const buffer = Buffer.from(value, 'base64url');
        const canonical = buffer.toString('base64url');
        if (buffer.length !== bytes || (value !== canonical && value !== canonical + '='.repeat((4 - canonical.length % 4) % 4))) return invalid();
        return buffer;
    };
    const publicKey = decode(input.keys?.p256dh, 65), authKey = decode(input.keys?.auth, 16);
    if (publicKey[0] !== 4) return invalid();
    ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed');
    return { endpoint: url.href, subscription: { endpoint: url.href,
        keys: { p256dh: publicKey.toString('base64url'), auth: authKey.toString('base64url') } } };
};
module.exports = { normalizeAdminPushSubscription };
