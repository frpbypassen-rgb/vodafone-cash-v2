// mappers/mobileErrorMapper.js
// ===============================================
// 🚨 Mobile API — Error Envelope الموحد
// ===============================================
'use strict';

/**
 * ينشئ كائن خطأ موحد لجميع أخطاء Mobile API.
 * @param {number} httpStatus - HTTP status code
 * @param {string} code - رمز الخطأ (مثل VALIDATION_ERROR, SERVER_ERROR)
 * @param {string} message - رسالة عربية آمنة للمستخدم
 * @param {string} correlationId - معرف الطلب للتتبع
 * @returns {{ success: boolean, code: string, message: string, correlationId: string }}
 */
const buildErrorEnvelope = (httpStatus, code, message, correlationId) => {
    return {
        httpStatus,
        body: {
            success: false,
            code,
            message,
            correlationId: correlationId || null
        }
    };
};

/**
 * يرسل خطأ Mobile API موحد على res.
 */
const sendMobileError = (res, httpStatus, code, message, correlationId) => {
    return res.status(httpStatus).json({
        success: false,
        code,
        message,
        correlationId: correlationId || null
    });
};

/**
 * Express error handler middleware لمسارات Mobile API.
 * يلتقط الأخطاء غير المعالجة ويرسل error envelope موحد.
 */
const mobileErrorHandler = (err, req, res, _next) => {
    const correlationId = req.correlationId || null;

    // أخطاء معروفة بأكواد واضحة
    const knownErrors = {
        'VALIDATION_ERROR': { status: 400, message: 'بيانات غير صالحة' },
        'INVALID_CREDENTIALS': { status: 401, message: 'بيانات الدخول غير صحيحة' },
        'TOKEN_EXPIRED': { status: 401, message: 'انتهت صلاحية الجلسة' },
        'TOKEN_INVALID': { status: 401, message: 'التوكن غير صالح' },
        'SESSION_REVOKED': { status: 403, message: 'تم إبطال الجلسة' },
        'ACCOUNT_BANNED': { status: 403, message: 'الحساب معلق' },
        'ACCOUNT_LOCKED': { status: 423, message: 'الحساب مقفل مؤقتاً' },
        'FORBIDDEN': { status: 403, message: 'صلاحيات غير كافية' },
        'NOT_FOUND': { status: 404, message: 'المورد غير موجود' },
        'TOO_MANY_REQUESTS': { status: 429, message: 'معدل الطلبات مرتفع جداً' },
        'EMPLOYEE_NOT_FOUND': { status: 404, message: 'لم يتم العثور على حساب المنفذ' },
        'ALREADY_TAKEN': { status: 409, message: 'تم سحب الطلب من منفذ آخر' },
        'INVALID_STATE': { status: 409, message: 'حالة العملية لا تسمح بهذا الإجراء' },
        'IDEMPOTENCY_KEY_REQUIRED': { status: 400, message: 'مفتاح منع التكرار مطلوب' },
        'IDEMPOTENCY_CONFLICT': { status: 409, message: 'مفتاح العملية مستخدم لطلب مختلف' },
        'INSUFFICIENT_BALANCE': { status: 400, message: 'الرصيد غير كافٍ' },
        'SYSTEM_CLOSED': { status: 403, message: 'المنظومة مغلقة حالياً' },
        'MALFORMED_IMAGE': { status: 400, message: 'صورة تالفة أو غير مدعومة' },
        'PAYLOAD_TOO_LARGE': { status: 413, message: 'حجم الطلب أكبر من المسموح' },
    };

    const code = err.code || err.message;
    const known = knownErrors[code];

    if (known) {
        return sendMobileError(res, known.status, code, err.userMessage || known.message, correlationId);
    }

    // خطأ غير متوقع → لا نسرب تفاصيل داخلية
    return sendMobileError(res, 500, 'SERVER_ERROR', 'حدث خطأ داخلي، يرجى المحاولة لاحقاً', correlationId);
};

module.exports = {
    buildErrorEnvelope,
    sendMobileError,
    mobileErrorHandler
};
