// middlewares/requireIdempotencyKey.js
// ===============================================
// 🛡️ Middleware — التحقق وإلزام مفتاح منع التكرار (Idempotency Key)
// ===============================================
'use strict';

const { sendMobileError } = require('../mappers/mobileErrorMapper');

/**
 * يتحقق من وجود وصحة مفتاح منع التكرار في الهيدرز.
 */
const requireIdempotencyKey = (req, res, next) => {
    const key = req.headers['idempotency-key'];
    
    if (!key) {
        return sendMobileError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'مفتاح منع التكرار (Idempotency-Key) مطلوب للعمليات المالية الحساسة', req.correlationId);
    }

    // التحقق من صيغة UUID صالحة
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (!uuidRegex.test(key)) {
        return sendMobileError(res, 400, 'VALIDATION_ERROR', 'صيغة مفتاح منع التكرار غير صالحة، يجب أن يكون UUID صالحاً', req.correlationId);
    }

    next();
};

module.exports = requireIdempotencyKey;
