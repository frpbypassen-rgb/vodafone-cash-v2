// middlewares/requestLogger.js
// ===============================================
// 📊 Request Logger Middleware — تسجيل كل الطلبات
// ===============================================
'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Middleware لتسجيل كل طلب HTTP مع وقت الاستجابة و correlation ID
 */
const requestLogger = (req, res, next) => {
    // توليد Correlation ID فريد لربط اللوجات ببعضها
    const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    const startTime = process.hrtime.bigint();
    const startTimestamp = new Date().toISOString();

    // تسجيل بداية الطلب
    const requestInfo = {
        correlationId,
        method: req.method,
        url: req.originalUrl || req.url,
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
            statusCode: res.statusCode,
            durationMs: Math.round(durationMs * 100) / 100,
            contentLength: res.getHeader('content-length') || 0,
            timestamp: startTimestamp
        };

        // تصنيف حسب الحالة
        if (res.statusCode >= 500) {
            logger.error('HTTP Request Failed', logData);
        } else if (res.statusCode >= 400) {
            logger.warn('HTTP Client Error', logData);
        } else if (durationMs > 5000) {
            logger.warn('HTTP Slow Request', logData);
        } else {
            // لا نسجل الطلبات الثابتة لتقليل الضجيج
            if (!req.originalUrl?.startsWith('/public') && !req.originalUrl?.startsWith('/favicon')) {
                logger.info('HTTP Request', logData);
            }
        }

        originalEnd.apply(res, args);
    };

    next();
};

module.exports = requestLogger;
