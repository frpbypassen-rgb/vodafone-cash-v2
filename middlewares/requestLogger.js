// middlewares/requestLogger.js
// ===============================================
// 📊 Request Logger Middleware — تسجيل كل الطلبات
// ===============================================
'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

const QUIET_PATH_RE = /\.(?:css|js|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf)$/i;
const QUIET_ENDPOINTS = new Set([
    '/health',
    '/health/ready',
    '/metrics',
    '/executor-portal/api/live-tasks',
    '/api/sidebar-stats',
    '/api/notifications/unread',
    '/client/api/transactions',
    '/client/api/notifications/unread'
]);
const SENSITIVE_QUERY_KEY_RE = /(?:token|secret|api[_-]?key|authorization|signature|sig)/i;
const MOBILE_AUTH_CODES = new Set([
    'TOKEN_MISSING', 'TOKEN_EXPIRED', 'TOKEN_INVALID', 'UNAUTHORIZED',
    'SESSION_REVOKED', 'SECURITY_SESSION_EXPIRED', 'TOKEN_REUSE_DETECTED',
    'TENANT_ACCESS_DENIED', 'TENANT_TOKEN_MISMATCH', 'TENANT_CREDENTIAL_INVALID',
    'ACCOUNT_BANNED', 'ACCOUNT_LOCKED', 'DEVICE_APPROVAL_REQUIRED',
    'DEVICE_NOT_APPROVED', 'DEVICE_BINDING_MISMATCH', 'SECURITY_VERIFICATION_REQUIRED'
]);

const redactRequestUrl = (requestUrl = '') => {
    try {
        const parsed = new URL(String(requestUrl), 'http://request.local');
        for (const key of parsed.searchParams.keys()) {
            if (SENSITIVE_QUERY_KEY_RE.test(key)) parsed.searchParams.set(key, '[REDACTED]');
        }
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (_error) {
        return String(requestUrl).replace(/([?&](?:token|secret|api[_-]?key|authorization|signature|sig)=)[^&]*/gi, '$1[REDACTED]');
    }
};

const shouldLogRequest = (requestUrl = '') => {
    const path = String(requestUrl).split('?')[0];
    return !(
        QUIET_PATH_RE.test(path)
        || path.startsWith('/css/')
        || path.startsWith('/images/')
        || path.startsWith('/uploads/')
        || path.startsWith('/socket.io/')
        || path.startsWith('/favicon')
        || QUIET_ENDPOINTS.has(path)
    );
};

/**
 * Middleware لتسجيل كل طلب HTTP مع وقت الاستجابة و correlation ID
 */
const requestLogger = (req, res, next) => {
    if (!shouldLogRequest(req.originalUrl || req.url)) return next();

    // توليد Correlation ID فريد لربط اللوجات ببعضها
    const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    const startTime = process.hrtime.bigint();
    const startTimestamp = new Date().toISOString();
    let authErrorCode;
    const mobilePath = /^\/api\/(?:v1\/)?mobile(?:\/|$)/.test(String(req.originalUrl || req.url).split('?')[0]);
    if (mobilePath && typeof res.json === 'function') {
        const originalJson = res.json;
        res.json = function (body) {
            if ([401, 403].includes(res.statusCode) && MOBILE_AUTH_CODES.has(body?.code)) authErrorCode = body.code;
            return originalJson.apply(this, arguments);
        };
    }

    // تسجيل بداية الطلب
    const requestInfo = {
        correlationId,
        method: req.method,
        url: redactRequestUrl(req.originalUrl || req.url),
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
        userAgent: req.headers['user-agent']?.substring(0, 100) || 'unknown'
    };

    // تسجيل نهاية الطلب مع وقت الاستجابة
    const originalEnd = res.end;
    res.end = function (...args) {
        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1_000_000;

        const logData = {
            ...requestInfo,
            pid: process.pid,
            ...([401, 403].includes(res.statusCode) && authErrorCode ? { authErrorCode } : {}),
            statusCode: res.statusCode,
            durationMs: Math.round(durationMs * 100) / 100,
            contentLength: res.getHeader('content-length') || 0,
            timestamp: startTimestamp
        };

        const result = originalEnd.apply(this, args);

        // لا نسمح للكتابة إلى ملفات السجل بتأخير استجابة المستخدم.
        setImmediate(() => {
            try {
                if (res.statusCode >= 500) {
                    logger.error('HTTP Request Failed', logData);
                } else if (res.statusCode >= 400) {
                    logger.warn('HTTP Client Error', logData);
                } else if (durationMs > 5000) {
                    logger.warn('HTTP Slow Request', logData);
                } else {
                logger.info('HTTP Request', logData);
                }
            } catch (_) {
                // لا يجب أن يؤثر فشل التسجيل على طلب المستخدم بعد إرساله.
            }
        });

        return result;
    };

    next();
};

module.exports = requestLogger;
