'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const logger = require('../utils/logger');
const sessions = new Map();
const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_JWT_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 256;
const RATE_LIMIT_CODE = 'PROVIDER_AUTH_RATE_LIMITED';
const DEFAULT_PROVIDER_HEADERS = Object.freeze({
    'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 Ahram-Server/1.0',
    Accept: 'application/json', 'app-version': 'xyz67'
});
const keyOf = config => crypto.createHash('sha256').update(JSON.stringify([
    config.baseUrl, config.apiUsername, config.apiPassword,
    config.preset.appType, config.preset.appId, config.preset.versionId,
    config.defaultHeaders
])).digest('hex');

const retryDelay = (response, now, consecutiveRateLimits) => {
    const header = String(response?.headers?.['retry-after'] ?? '').trim();
    if (/^\d{1,8}$/.test(header)) return { seconds: Math.max(1, Number(header)), source: 'provider_header' };
    const date = /GMT$/i.test(header) ? Date.parse(header) : NaN;
    return Number.isFinite(date) ? { seconds: Math.max(1, Math.ceil((date - now) / 1000)), source: 'provider_header' }
        : { seconds: Math.min(900, 60 * (2 ** (consecutiveRateLimits - 1))), source: 'local_fallback' };
};
const throttled = response => Number(response?.status) === 429 || Number(response?.data?.Code) === 429
    || /too many (?:attempts|requests)|rate limit/i.test(String(typeof response?.data === 'string' ? response.data : response?.data?.Message || response?.data?.message || response?.data?.error || ''));
const failure = entry => {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.blockedUntil - Date.now()) / 1000));
    return Object.assign(new Error(entry.code === RATE_LIMIT_CODE
        ? (entry.retryAfterSource === 'local_fallback'
            ? `رفضت بوابة المزود تسجيل الدخول بسبب تقييد المحاولات. تهدئة محلية ${retryAfterSeconds} ثانية؛ لم يحدد المزود موعد رفع القيد.`
            : `المزود يقيّد تسجيل الدخول مؤقتاً. انتظر ${retryAfterSeconds} ثانية حسب مهلة المزود قبل المحاولة التالية.`)
        : 'تعذر تسجيل الدخول لدى المزود. تحقق من بيانات الاتصال قبل إعادة المحاولة.'), {
        code: entry.code, retryAfterSeconds, retryAfterSource: entry.retryAfterSource,
        providerHttpStatus: entry.providerHttpStatus, providerCode: entry.providerCode
    });
};
const tokenDeadline = (token, now) => {
    let deadline = now + TOKEN_TTL_MS;
    try {
        const parts = token.split('.');
        if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            // Reusing a provider-issued JWT does not require another login every
            // five minutes. Expiry is a cache hint; every API read still checks
            // the upstream response and invalidates a rejected token on 401.
            if (Number.isFinite(payload.exp)) deadline = Math.min(now + MAX_JWT_CACHE_MS, payload.exp * 1000 - 15000);
        }
    } catch (_) { /* An opaque vendor token is valid without JWT claims. */ }
    return deadline;
};

async function getProviderAuthSession(config, { onLogin, onRejected } = {}) {
    const key = keyOf(config);
    let entry = sessions.get(key);
    const now = Date.now();
    if (entry?.blockedUntil > now) throw failure(entry);
    if (entry?.token && entry.validUntil > now) return { token: entry.token, cached: true };
    if (entry?.promise) return entry.promise;
    if (!entry) {
        for (const [candidate, value] of sessions) {
            if (!value.promise && value.validUntil <= now && value.blockedUntil <= now) sessions.delete(candidate);
        }
        if (sessions.size >= MAX_SESSIONS) {
            const oldest = [...sessions].find(([, value]) => !value.promise && value.blockedUntil <= now);
            if (!oldest) throw Object.assign(new Error('مصادقة المزود مشغولة. أعد المحاولة لاحقاً.'), { code: 'PROVIDER_AUTH_BUSY' });
            sessions.delete(oldest[0]);
        }
        entry = { token: null, validUntil: 0, blockedUntil: 0, promise: null };
        sessions.set(key, entry);
    }
    entry.promise = (async () => {
        onLogin?.();
        let response;
        try {
            response = await axios.post(config.baseUrl + '/api/Account/GetToken', {
                UserName: config.apiUsername, Password: config.apiPassword,
                AppType: config.preset.appType, AppId: config.preset.appId, VersionID: config.preset.versionId
            }, { headers: config.defaultHeaders, timeout: 15000, maxRedirects: 0 });
            if (throttled(response)) throw Object.assign(new Error('PROVIDER_AUTH_REJECTED'), { response });
            const token = response.data?.Data?.Access_Token;
            if (Number(response.data?.Code) !== 200 || typeof token !== 'string' || !token.trim()) {
                throw Object.assign(new Error('PROVIDER_AUTH_REJECTED'), { response });
            }
            const validUntil = tokenDeadline(token.trim(), Date.now());
            if (validUntil <= Date.now()) throw new Error('PROVIDER_TOKEN_EXPIRED');
            entry.token = token.trim();
            entry.validUntil = validUntil;
            entry.blockedUntil = 0;
            entry.consecutiveRateLimits = 0;
            try {
                logger.info?.('PROVIDER_AUTH_SESSION_ESTABLISHED', {
                    cacheTtlSeconds: Math.floor((validUntil - Date.now()) / 1000)
                });
            } catch (_) { /* Diagnostic failures cannot invalidate a successful login. */ }
            return { token: entry.token, cached: false };
        } catch (error) {
            response = error.response || response;
            try { onRejected?.(response); } catch (_) { /* Diagnostic hooks cannot disable backoff. */ }
            entry.token = null;
            entry.validUntil = 0;
            entry.code = throttled(response) ? RATE_LIMIT_CODE : 'PROVIDER_AUTH_REJECTED';
            entry.consecutiveRateLimits = entry.code === RATE_LIMIT_CODE ? Math.min(5, (entry.consecutiveRateLimits || 0) + 1) : 0;
            const delay = entry.code === RATE_LIMIT_CODE ? retryDelay(response, Date.now(), entry.consecutiveRateLimits) : { seconds: 5, source: 'local_fallback' };
            entry.retryAfterSource = delay.source;
            const status = Number(response?.status), providerCode = Number(response?.data?.Code);
            entry.providerHttpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
            entry.providerCode = Number.isSafeInteger(providerCode) && providerCode > 0 ? providerCode : null;
            entry.blockedUntil = Date.now() + delay.seconds * 1000;
            if (entry.code === RATE_LIMIT_CODE) logger.warn('PROVIDER_AUTH_THROTTLED', {
                providerHttpStatus: entry.providerHttpStatus,
                providerCode: entry.providerCode,
                retryAfterSource: entry.retryAfterSource,
                consecutiveRateLimits: entry.consecutiveRateLimits,
                retryAfterSeconds: Math.ceil((entry.blockedUntil - Date.now()) / 1000)
            });
            // Cache only safe state: never retain an Axios error/request with credentials.
            throw failure(entry);
        }
    })();
    try { return await entry.promise; }
    finally { entry.promise = null; }
}

function invalidateProviderAuthSession(config, authorization) {
    const entry = sessions.get(keyOf(config));
    const expected = String(authorization || '').replace(/^Bearer\s+/i, '');
    if (entry && (!expected || entry.token === expected)) { entry.token = null; entry.validUntil = 0; }
}
function clearProviderAuthSessions() { sessions.clear(); }

module.exports = { getProviderAuthSession, invalidateProviderAuthSession, clearProviderAuthSessions, RATE_LIMIT_CODE, DEFAULT_PROVIDER_HEADERS };
