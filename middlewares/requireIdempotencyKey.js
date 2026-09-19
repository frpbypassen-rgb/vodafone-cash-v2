// middlewares/requireIdempotencyKey.js
// ===============================================
// 🛡️ Middleware — التحقق وإلزام مفتاح منع التكرار (Idempotency Key)
// ===============================================
'use strict';

const { sendMobileError } = require('../mappers/mobileErrorMapper');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isMerchantRequest = (req) => String(req.baseUrl || req.originalUrl || '').includes('/merchant');

const requireIdempotencyKey = (req, res, next) => {
    const key = req.headers['idempotency-key'];
    const merchant = isMerchantRequest(req);

    if (!key) {
        if (merchant) {
            return res.status(400).json({
                status: 'failed',
                code: 'IDEMPOTENCY_KEY_REQUIRED',
                message: 'مفتاح منع التكرار (Idempotency-Key) مطلوب للعمليات المالية الحساسة'
            });
        }
        return sendMobileError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'مفتاح منع التكرار (Idempotency-Key) مطلوب للعمليات المالية الحساسة', req.correlationId);
    }

    if (!UUID_REGEX.test(key)) {
        if (merchant) {
            return res.status(400).json({
                status: 'failed',
                code: 'VALIDATION_ERROR',
                message: 'صيغة مفتاح منع التكرار غير صالحة، يجب أن يكون UUID صالحاً'
            });
        }
        return sendMobileError(res, 400, 'VALIDATION_ERROR', 'صيغة مفتاح منع التكرار غير صالحة، يجب أن يكون UUID صالحاً', req.correlationId);
    }

    next();
};

module.exports = requireIdempotencyKey;
