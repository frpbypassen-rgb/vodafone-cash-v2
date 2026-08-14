// validators/mobileValidators.js
// Ø·Ø¨Ù‚Ø© Ø§Ù„ØªØ­Ù‚Ù‚ Ù…Ù† Ø§Ù„Ù…Ø¯Ø®Ù„Ø§Øª Ù„Ù…Ø³Ø§Ø±Ø§Øª Mobile API
'use strict';

const { body, validationResult } = require('express-validator');
const { sendMobileError } = require('../mappers/mobileErrorMapper');
const { getEnabledMobileTransferServiceKeys, getTransferServiceDefinition } = require('../utils/mobileTransferServiceCatalog');

/**
 * Middleware Ù„Ù„ØªØ­Ù‚Ù‚ Ù…Ù† Ù†ØªØ§Ø¦Ø¬ Ø§Ù„Ù€ validation ÙˆØ¥Ø±Ø¬Ø§Ø¹ Ø®Ø·Ø£ Ù…ÙˆØ­Ø¯
 */
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const first = errors.array()[0];
        return sendMobileError(res, 400, 'VALIDATION_ERROR', first.msg, req.correlationId);
    }
    next();
};

const MAX_SUPPORT_IMAGE_BYTES = 4 * 1024 * 1024;
const DATA_IMAGE_PREFIX = /^data:image\/(jpeg|jpg|png|webp);base64,/i;

const validateBase64Image = (value, maxBytes = MAX_SUPPORT_IMAGE_BYTES) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Ø§Ù„ØµÙˆØ±Ø© Ø§Ù„Ù…Ø±ÙÙ‚Ø© ØºÙŠØ± ØµØ§Ù„Ø­Ø©');
    }

    if (!DATA_IMAGE_PREFIX.test(value)) {
        throw new Error('Ø§Ù„ØµÙˆØ±Ø© ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† Ø¨ØµÙŠØºØ© jpeg Ø£Ùˆ png Ø£Ùˆ webp');
    }

    const base64Data = value.replace(DATA_IMAGE_PREFIX, '');
    if (base64Data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64Data)) {
        throw new Error('Ø§Ù„ØµÙˆØ±Ø© ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† Ù†Øµ Base64 ØµØ§Ù„Ø­');
    }

    const sizeInBytes = Buffer.from(base64Data, 'base64').length;
    if (sizeInBytes > maxBytes) {
        throw new Error('Ø­Ø¬Ù… Ø§Ù„ØµÙˆØ±Ø© ÙŠØ¬Ø¨ Ø£Ù„Ø§ ÙŠØªØ¬Ø§ÙˆØ² 4 Ù…ÙŠØ¬Ø§Ø¨Ø§ÙŠØª');
    }

    return true;
};

// â”€â”€ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const loginValidator = [
    body('username')
        .trim()
        .notEmpty().withMessage('Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 3, max: 50 }).withMessage('Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 3 Ùˆ50 Ø­Ø±Ù')
        .escape(),
    body('password')
        .trim()
        .notEmpty().withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ù…Ø·Ù„ÙˆØ¨Ø©')
        .isLength({ min: 4, max: 100 }).withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† 4 Ø£Ø­Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„'),
    validate
];

// â”€â”€ Ø¥Ù†Ø´Ø§Ø¡ ØªØ­ÙˆÙŠÙ„ Ø¬Ø¯ÙŠØ¯ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const transferValidator = [
    body('amount')
        .notEmpty().withMessage('المبلغ مطلوب')
        .isFloat({ min: 1, max: 500000 }).withMessage('المبلغ يجب أن يكون بين 1 و500,000'),
    body('number')
        .trim()
        .notEmpty().withMessage('رقم الهاتف أو الحساب مطلوب')
        .isLength({ min: 3, max: 50 }).withMessage('بيانات المستلم يجب أن تكون بين 3 و50 خانة'),
    body('transferType')
        .trim()
        .notEmpty().withMessage('Ù†ÙˆØ¹ Ø§Ù„ØªØ­ÙˆÙŠÙ„ Ù…Ø·Ù„ÙˆØ¨')
        .isIn(getEnabledMobileTransferServiceKeys())
        .withMessage('نوع التحويل غير صالح للموبايل'),
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
    body('serviceSubtype')
        .optional()
        .trim()
        .isLength({ min: 2, max: 32 }).withMessage('نوع الخدمة الفرعي غير صالح')
        .escape(),
    body('city')
        .optional()
        .trim()
        .isLength({ max: 80 }).withMessage('اسم المدينة لا يتجاوز 80 حرف')
        .escape(),
    body('bankName')
        .optional()
        .trim()
        .isLength({ max: 100 }).withMessage('اسم البنك لا يتجاوز 100 حرف')
        .escape(),
    body().custom((body) => {
        const { transferType, name, number, idCardImage, oldReceiptImage, serviceSubtype, city, recipientPhone, governorate, bankName } = body;
        const service = getTransferServiceDefinition(transferType);
        if (!service || !service.mobileEnabled) {
            throw new Error('نوع التحويل غير مدعوم للموبايل');
        }
        
        if (transferType === 'post_card') {
            if (!name) {
                throw new Error('اسم المستفيد الثلاثي مطلوب لهذا النوع من التحويل');
            }
            if (name.trim().split(/\s+/).filter(Boolean).length < 3) {
                throw new Error('اسم المستلم يجب أن يكون ثلاثياً (3 كلمات على الأقل)');
            }
            if (!number || !/^\d{14}$/.test(number)) {
                throw new Error('الرقم القومي للمستلم مطلوب ويجب أن يكون 14 رقماً');
            }
            if (!recipientPhone || !/^(010|011|012|015)\d{8}$/.test(recipientPhone)) {
                throw new Error('رقم هاتف المستلم يجب أن يكون 11 رقماً ويبدأ بـ 010 أو 011 أو 012 أو 015');
            }
            if (!governorate || !String(governorate).trim()) {
                throw new Error('اختر محافظة المستلم في مصر');
            }
            const amount = Number(body.amount);
            if (!Number.isFinite(amount) || amount < 500) {
                throw new Error('الحد الأدنى لتحويل بريد بطاقة هو 500 جنيه مصري');
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
                throw new Error('اسم المستفيد الثلاثي مطلوب لهذا النوع من التحويل');
            }
            if (name.trim().split(/\s+/).filter(Boolean).length < 3) {
                throw new Error('الاسم المستلم يجب أن يكون ثلاثياً (3 كلمات على الأقل)');
            }
            if (!number || !/^\d{15}$/.test(number)) {
                throw new Error('رقم الحساب البريدي يجب أن يكون 15 رقماً');
            }
            const amount = Number(body.amount);
            if (!Number.isFinite(amount) || amount < 500) {
                throw new Error('الحد الأدنى لتحويل بريد حساب هو 500 جنيه مصري');
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
            if (!number || !/^(010|011|012|015)\d{8}$/.test(number)) {
                throw new Error('رقم مستلم الكاش يجب أن يكون 11 رقماً ويبدأ بـ 010 أو 011 أو 012 أو 015');
            }
            const amount = Number(body.amount);
            if (!Number.isFinite(amount) || amount < 100 || amount > 50000) {
                throw new Error('قيمة تحويل محافظ كاش يجب أن تكون بين 100 و50,000 جنيه مصري للعملية الواحدة');
            }
        }

        if (transferType === 'bank_account') {
            if (!name || name.trim().split(/\s+/).filter(Boolean).length < 3) {
                throw new Error('اسم المستفيد يجب أن يكون ثلاثياً لتحويل الحساب البنكي');
            }
            const isInstapay = serviceSubtype === 'instapay';
            const bankRecipientPattern = isInstapay
                ? /^(?:(010|011|012|015)\d{8}|[A-Za-z0-9._@-]{3,50}|\d{16})$/
                : /^[A-Za-z0-9\s-]{8,34}$/;
            if (!number || !bankRecipientPattern.test(number.replace(/\s+/g, ''))) {
                throw new Error(isInstapay
                    ? 'أدخل رقم هاتف أو عنوان دفع لحظي أو رقم بطاقة إلكترونية صحيحاً'
                    : 'رقم الحساب البنكي أو IBAN غير صالح');
            }
            const amount = Number(body.amount);
            if (!Number.isFinite(amount) || amount < 500) {
                throw new Error(isInstapay
                    ? 'الحد الأدنى لتحويل إنستا باي هو 500 جنيه مصري'
                    : 'الحد الأدنى للتحويل البنكي هو 500 جنيه مصري');
            }
            if (!isInstapay) {
                if (!bankName || !String(bankName).trim()) {
                    throw new Error('اختر اسم البنك قبل إرسال التحويل البنكي');
                }
            }
        }

        if (transferType === 'sefa_niger') {
            const subtype = serviceSubtype || 'nita';
            if (!service.allowedSubtypes || !service.allowedSubtypes.includes(subtype)) {
                throw new Error('نوع خدمة سيفا النيجر غير صالح');
            }
            if (!name || name.trim().length < 2) {
                throw new Error('اسم المستفيد مطلوب لسيفا النيجر');
            }
            if (!number || !/^\d{8,11}$/.test(number)) {
                throw new Error('رقم حساب NITA يجب أن يتكون من 8 إلى 11 رقماً');
            }
            if (subtype === 'nita' && (!city || city.trim().length < 2)) {
                throw new Error('اسم المدينة مطلوب لخدمة NITA');
            }
            const amount = Number(body.amount);
            if (!Number.isInteger(amount) || amount < 10) {
                throw new Error('مبلغ سيفا النيجر يجب أن يكون رقماً صحيحاً لا يقل عن 10 سيفا');
            }
        }

        if (transferType === 'bankak_sudan') {
            if (!name || name.trim().length < 3) {
                throw new Error('اسم المستفيد مطلوب لبنكك السودان');
            }
            if (!number || !/^\d{14}$/.test(number)) {
                throw new Error('رقم حساب بنكك يجب أن يتكون من 14 رقماً');
            }
            const recipientPhone = String(body.recipientPhone || '').replace(/\s+/g, '');
            if (!/^\+?\d{9,15}$/.test(recipientPhone)) {
                throw new Error('رقم هاتف المستلم مطلوب لبنكك السودان');
            }
        }
        return true;
    }),
    validate
];

// â”€â”€ Ø¥Ù„ØºØ§Ø¡ Ù…Ù‡Ù…Ø© â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const cancelTaskValidator = [
    body('reason')
        .trim()
        .notEmpty().withMessage('Ø³Ø¨Ø¨ Ø§Ù„Ø¥Ù„ØºØ§Ø¡ Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 5, max: 300 }).withMessage('Ø³Ø¨Ø¨ Ø§Ù„Ø¥Ù„ØºØ§Ø¡ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 5 Ùˆ300 Ø­Ø±Ù')
        .escape(),
    validate
];

// â”€â”€ Ø¥ØªÙ…Ø§Ù… Ù…Ù‡Ù…Ø© â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const completeTaskValidator = [
    body('imageBase64')
        .optional({ checkFalsy: true })
        .isString().withMessage('ØµÙˆØ±Ø© Ø§Ù„Ø¥Ø«Ø¨Ø§Øª ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† Ù†Øµ Base64'),
    body('executionNumber')
        .optional()
        .trim()
        .isLength({ min: 3, max: 20 }).withMessage('رقم التنفيذ غير صالح'),
    body('senderPhone')
        .optional()
        .trim()
        .isLength({ min: 7, max: 20 }).withMessage('Ø±Ù‚Ù… Ø§Ù„Ù…Ø±Ø³Ù„ ØºÙŠØ± ØµØ§Ù„Ø­'),
    validate
];

// â”€â”€ ØªØ¬Ø¯ÙŠØ¯ Ø§Ù„ØªÙˆÙƒÙ† â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const refreshTokenValidator = [
    body('refreshToken')
        .trim()
        .notEmpty().withMessage('Refresh Token Ù…Ø·Ù„ÙˆØ¨'),
    validate
];

const clientReportsValidator = [
    body('dateType')
        .optional()
        .trim()
        .isIn(['day', 'month']).withMessage('Ù†ÙˆØ¹ Ø§Ù„ØªØ§Ø±ÙŠØ® ØºÙŠØ± ØµØ§Ù„Ø­'),
    body('dateValue')
        .optional()
        .trim()
        .isLength({ min: 4, max: 20 }).withMessage('Ù‚ÙŠÙ…Ø© Ø§Ù„ØªØ§Ø±ÙŠØ® ØºÙŠØ± ØµØ§Ù„Ø­Ø©'),
    validate
];

const lookupValidator = [
    body('targetAccountCode')
        .trim()
        .notEmpty().withMessage('ÙƒÙˆØ¯ Ø§Ù„Ù…Ø³ØªÙ„Ù… Ù…Ø·Ù„ÙˆØ¨'),
    validate
];

const balanceTransferValidator = [
    body('targetAccountCode')
        .trim()
        .notEmpty().withMessage('ÙƒÙˆØ¯ Ø§Ù„Ù…Ø³ØªÙ„Ù… Ù…Ø·Ù„ÙˆØ¨'),
    body('amount')
        .notEmpty().withMessage('Ø§Ù„Ù…Ø¨Ù„Øº Ù…Ø·Ù„ÙˆØ¨')
        .isFloat({ min: 0.01, max: 500000 }).withMessage('Ø§Ù„Ù…Ø¨Ù„Øº ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 0.01 Ùˆ 500,000'),
    body('notes')
        .optional()
        .trim()
        .escape(),
    validate
];

const complaintValidator = [
    body('transactionId')
        .trim()
        .notEmpty().withMessage('Ù…Ø¹Ø±Ù Ø§Ù„Ø¹Ù…Ù„ÙŠØ© Ù…Ø·Ù„ÙˆØ¨'),
    body('complaintText')
        .trim()
        .notEmpty().withMessage('Ù†Øµ Ø§Ù„Ø´ÙƒÙˆÙ‰ Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 5, max: 1000 }).withMessage('Ù†Øµ Ø§Ù„Ø´ÙƒÙˆÙ‰ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 5 Ùˆ 1000 Ø­Ø±Ù')
        .escape(),
    validate
];

const depositRequestValidator = [
    body('amount')
        .notEmpty().withMessage('Ø§Ù„Ù…Ø¨Ù„Øº Ù…Ø·Ù„ÙˆØ¨')
        .isFloat({ min: 1, max: 1000000 }).withMessage('Ø§Ù„Ù…Ø¨Ù„Øº ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 1 Ùˆ 1,000,000'),
    validate
];

const editAmountValidator = [
    body('newAmount')
        .notEmpty().withMessage('Ø§Ù„Ù…Ø¨Ù„Øº Ø§Ù„Ø¬Ø¯ÙŠØ¯ Ù…Ø·Ù„ÙˆØ¨')
        .isFloat({ min: 0.01, max: 500000 }).withMessage('Ø§Ù„Ù…Ø¨Ù„Øº ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 0.01 Ùˆ 500,000'),
    body('reason')
        .trim()
        .notEmpty().withMessage('Ø§Ù„Ø³Ø¨Ø¨ Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 5, max: 300 }).withMessage('Ø§Ù„Ø³Ø¨Ø¨ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 5 Ùˆ 300 Ø­Ø±Ù')
        .escape(),
    validate
];

const returnTaskValidator = [
    body('reason')
        .trim()
        .notEmpty().withMessage('Ø§Ù„Ø³Ø¨Ø¨ Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 5, max: 300 }).withMessage('Ø§Ù„Ø³Ø¨Ø¨ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 5 Ùˆ 300 Ø­Ø±Ù')
        .escape(),
    validate
];

const createEmployeeValidator = [
    body('name')
        .trim()
        .notEmpty().withMessage('Ø§Ù„Ø§Ø³Ù… Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 3, max: 100 }).withMessage('Ø§Ù„Ø§Ø³Ù… ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 3 Ùˆ 100 Ø­Ø±Ù')
        .escape(),
    body('phone')
        .optional()
        .trim()
        .escape(),
    body('role')
        .trim()
        .notEmpty().withMessage('Ø§Ù„Ø¯ÙˆØ± Ù…Ø·Ù„ÙˆØ¨')
        .isIn(['operator', 'accountant']).withMessage('Ø§Ù„Ø¯ÙˆØ± ØºÙŠØ± ØµØ§Ù„Ø­'),
    body('webUsername')
        .trim()
        .notEmpty().withMessage('Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 3, max: 100 }).withMessage('Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 3 Ùˆ 100 Ø­Ø±Ù')
        .escape(),
    body('webPassword')
        .trim()
        .notEmpty().withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ù…Ø·Ù„ÙˆØ¨Ø©')
        .isLength({ min: 4, max: 100 }).withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† 4 Ø£Ø­Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„'),
    body('webPassword').custom((value) => {
        const password = String(value || '');
        if (password.length < 8) {
            throw new Error('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† 8 Ø£Ø­Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„');
        }
        if (!/^(?=.*[A-Za-z])(?=.*\d).+$/.test(password)) {
            throw new Error('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªØ­ØªÙˆÙŠ Ø¹Ù„Ù‰ Ø­Ø±Ù ÙˆØ±Ù‚Ù… Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„');
        }
        return true;
    }),
    validate
];

const updateExecutorEmployeeProfileValidator = [
    body('name')
        .trim()
        .notEmpty().withMessage('الاسم مطلوب')
        .isLength({ min: 3, max: 100 }).withMessage('الاسم يجب أن يكون بين 3 و100 حرف')
        .escape(),
    body('phone')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 40 }).withMessage('رقم الهاتف طويل جداً')
        .escape(),
    validate
];

const customerProfilePhotoValidator = [
    body('imageBase64').custom((value) => validateBase64Image(value, 2 * 1024 * 1024)),
    validate
];

const customerProfileValidator = [
    body('name')
        .trim()
        .isLength({ min: 3, max: 100 }).withMessage('الاسم يجب أن يكون بين 3 و100 حرف')
        .escape(),
    body('address')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 200 }).withMessage('العنوان طويل جداً')
        .escape(),
    validate
];

const customerPasswordValidator = [
    body('currentPassword')
        .isString().withMessage('كلمة المرور الحالية مطلوبة')
        .isLength({ min: 1, max: 100 }).withMessage('كلمة المرور الحالية غير صالحة'),
    body('newPassword')
        .isString().withMessage('كلمة المرور الجديدة مطلوبة')
        .isLength({ min: 8, max: 100 }).withMessage('كلمة المرور يجب أن تكون 8 أحرف على الأقل')
        .custom((value) => {
            if (!/^(?=.*[A-Za-z])(?=.*\d).+$/.test(String(value || ''))) {
                throw new Error('كلمة المرور يجب أن تحتوي على حرف ورقم على الأقل');
            }
            return true;
        }),
    validate
];

const resetPasswordValidator = [
    body('newPassword')
        .trim()
        .notEmpty().withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ø§Ù„Ø¬Ø¯ÙŠØ¯Ø© Ù…Ø·Ù„ÙˆØ¨Ø©')
        .isLength({ min: 4, max: 100 }).withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† 4 Ø£Ø­Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„'),
    body('newPassword').custom((value) => {
        const password = String(value || '');
        if (password.length < 8) {
            throw new Error('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† 8 Ø£Ø­Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„');
        }
        if (!/^(?=.*[A-Za-z])(?=.*\d).+$/.test(password)) {
            throw new Error('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªØ­ØªÙˆÙŠ Ø¹Ù„Ù‰ Ø­Ø±Ù ÙˆØ±Ù‚Ù… Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„');
        }
        return true;
    }),
    validate
];

const executorReportsValidator = [
    body('employeeId')
        .optional({ nullable: true, checkFalsy: true })
        .trim()
        .isMongoId().withMessage('معرف الموظف غير صالح'),
    body('dateType')
        .optional()
        .trim()
        .isIn(['day', 'month']).withMessage('Ù†ÙˆØ¹ Ø§Ù„ØªØ§Ø±ÙŠØ® ØºÙŠØ± ØµØ§Ù„Ø­'),
    body('dateValue')
        .optional()
        .trim()
        .isLength({ min: 4, max: 20 }).withMessage('Ù‚ÙŠÙ…Ø© Ø§Ù„ØªØ§Ø±ÙŠØ® ØºÙŠØ± ØµØ§Ù„Ø­Ø©'),
    validate
];

const executorSupportMessageValidator = [
    body('text')
        .optional({ nullable: true, checkFalsy: true })
        .trim()
        .isLength({ max: 1000 }).withMessage('Ù†Øµ Ø§Ù„Ø±Ø³Ø§Ù„Ø© ÙŠØ¬Ø¨ Ø£Ù„Ø§ ÙŠØªØ¬Ø§ÙˆØ² 1000 Ø­Ø±Ù')
        .escape(),
    body('imageBase64')
        .optional({ nullable: true, checkFalsy: true })
        .custom((value) => validateBase64Image(value)),
    body().custom((payload) => {
        if (!payload.text && !payload.imageBase64) {
            throw new Error('ÙŠØ¬Ø¨ Ø¥Ø±Ø³Ø§Ù„ Ù†Øµ Ø£Ùˆ ØµÙˆØ±Ø©');
        }
        return true;
    }),
    validate
];

module.exports = {
    loginValidator,
    transferValidator,
    cancelTaskValidator,
    completeTaskValidator,
    refreshTokenValidator,
    clientReportsValidator,
    lookupValidator,
    balanceTransferValidator,
    complaintValidator,
    depositRequestValidator,
    editAmountValidator,
    returnTaskValidator,
    createEmployeeValidator,
    updateExecutorEmployeeProfileValidator,
    customerProfilePhotoValidator,
    customerProfileValidator,
    customerPasswordValidator,
    resetPasswordValidator,
    executorReportsValidator,
    executorSupportMessageValidator
};

