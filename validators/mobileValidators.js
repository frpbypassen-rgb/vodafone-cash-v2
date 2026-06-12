// validators/mobileValidators.js
// طبقة التحقق من المدخلات لمسارات Mobile API
'use strict';

const { body, validationResult } = require('express-validator');
const { sendMobileError } = require('../mappers/mobileErrorMapper');

/**
 * Middleware للتحقق من نتائج الـ validation وإرجاع خطأ موحد
 */
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const first = errors.array()[0];
        return sendMobileError(res, 400, 'VALIDATION_ERROR', first.msg, req.correlationId);
    }
    next();
};

// ── تسجيل الدخول ──────────────────────────────────────────────────
const loginValidator = [
    body('username')
        .trim()
        .notEmpty().withMessage('اسم المستخدم مطلوب')
        .isLength({ min: 3, max: 50 }).withMessage('اسم المستخدم يجب أن يكون بين 3 و50 حرف')
        .escape(),
    body('password')
        .trim()
        .notEmpty().withMessage('كلمة المرور مطلوبة')
        .isLength({ min: 4, max: 100 }).withMessage('كلمة المرور يجب أن تكون 4 أحرف على الأقل'),
    validate
];

// ── إنشاء تحويل جديد ──────────────────────────────────────────────
const transferValidator = [
    body('amount')
        .notEmpty().withMessage('المبلغ مطلوب')
        .isFloat({ min: 1, max: 500000 }).withMessage('المبلغ يجب أن يكون بين 1 و500,000'),
    body('number')
        .trim()
        .notEmpty().withMessage('رقم الهاتف أو الحساب مطلوب')
        .isLength({ min: 5, max: 30 }).withMessage('الرقم يجب أن يكون بين 5 و30 خانة'),
    body('transferType')
        .trim()
        .notEmpty().withMessage('نوع التحويل مطلوب')
        .isIn(['vodafone', 'post_account', 'post_card'])
        .withMessage('نوع التحويل غير صالح. المسموح فقط: vodafone, post_account, post_card'),
    body('name')
        .optional()
        .trim()
        .isLength({ max: 100 }).withMessage('الاسم لا يتجاوز 100 حرف')
        .escape(),
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 500 }).withMessage('الملاحظات لا تتجاوز 500 حرف')
        .escape(),
    body().custom((body) => {
        const { transferType, name, number, idCardImage, oldReceiptImage } = body;
        
        if (transferType === 'post_card') {
            if (!name) {
                throw new Error('الاسم رباعي مطلوب لهذا النوع من التحويل');
            }
            if (name.trim().split(/\s+/).filter(Boolean).length < 4) {
                throw new Error('الاسم المستلم يجب أن يكون رباعياً (4 كلمات على الأقل)');
            }
            if (!number || !/^\d{14}$/.test(number)) {
                throw new Error('الرقم القومي للمستلم مطلوب ويجب أن يكون 14 رقماً');
            }
            if (!idCardImage) {
                throw new Error('صورة وجه البطاقة الشخصية للمستلم مطلوبة');
            }
            const base64Data = idCardImage.replace(/^data:image\/\w+;base64,/, '');
            if (base64Data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64Data)) {
                throw new Error('صورة البطاقة الشخصية يجب أن تكون نص Base64 صالح');
            }
            const sizeInBytes = Buffer.from(base64Data, 'base64').length;
            if (sizeInBytes > 5 * 1024 * 1024) {
                throw new Error('حجم صورة البطاقة الشخصية يجب ألا يتجاوز 5 ميجابايت');
            }
        }
        
        if (transferType === 'post_account') {
            if (!name) {
                throw new Error('الاسم رباعي مطلوب لهذا النوع من التحويل');
            }
            if (name.trim().split(/\s+/).filter(Boolean).length < 4) {
                throw new Error('الاسم المستلم يجب أن يكون رباعياً (4 كلمات على الأقل)');
            }
            if (!number) {
                throw new Error('رقم الحساب مطلوب');
            }
            if (oldReceiptImage) {
                const base64Data = oldReceiptImage.replace(/^data:image\/\w+;base64,/, '');
                if (base64Data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64Data)) {
                    throw new Error('صورة الإيصال القديم يجب أن تكون نص Base64 صالح');
                }
                const sizeInBytes = Buffer.from(base64Data, 'base64').length;
                if (sizeInBytes > 5 * 1024 * 1024) {
                    throw new Error('حجم صورة الإيصال القديم يجب ألا يتجاوز 5 ميجابايت');
                }
            }
        }
        
        if (transferType === 'vodafone') {
            if (!number || !/^\d{10,15}$/.test(number)) {
                throw new Error('رقم مستلم الكاش يجب أن يكون بين 10 و 15 رقماً');
            }
        }
        
        return true;
    }),
    validate
];

// ── إلغاء مهمة ────────────────────────────────────────────────────
const cancelTaskValidator = [
    body('reason')
        .trim()
        .notEmpty().withMessage('سبب الإلغاء مطلوب')
        .isLength({ min: 5, max: 300 }).withMessage('سبب الإلغاء يجب أن يكون بين 5 و300 حرف')
        .escape(),
    validate
];

// ── إتمام مهمة ────────────────────────────────────────────────────
const completeTaskValidator = [
    body('imageBase64')
        .notEmpty().withMessage('صورة الإثبات مطلوبة')
        .isString().withMessage('صورة الإثبات يجب أن تكون نص Base64'),
    body('senderPhone')
        .optional()
        .trim()
        .isLength({ min: 7, max: 20 }).withMessage('رقم المرسل غير صالح'),
    validate
];

// ── تجديد التوكن ──────────────────────────────────────────────────
const refreshTokenValidator = [
    body('refreshToken')
        .trim()
        .notEmpty().withMessage('Refresh Token مطلوب'),
    validate
];

module.exports = {
    loginValidator,
    transferValidator,
    cancelTaskValidator,
    completeTaskValidator,
    refreshTokenValidator
};
