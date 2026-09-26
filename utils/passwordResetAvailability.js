'use strict';

const rateLimit = require('express-rate-limit');
const { getBrandContact } = require('./brandContact');

const LRM = '\u200E';
const LRI = '\u2066';
const PDI = '\u2069';

const isolateLtr = (value) => `${LRM}${LRI}${value}${PDI}`;

const passwordResetSupportSentence = (env = process.env) => {
    const brand = getBrandContact(env);
    return `استعادة كلمة المرور غير متاحة حالياً. تواصل مع الدعم على ${isolateLtr(brand.phoneDisplay)} أو ${isolateLtr(brand.supportEmail)}`;
};

const passwordResetStartBody = (requestId, env = process.env) => {
    const brand = getBrandContact(env);
    return {
        success: true,
        code: 'PASSWORD_RESET_STARTED',
        requestId: String(requestId || ''),
        error: '',
        message: `إذا كان للحساب بريد مفعّل لاستقبال رمز الاستعادة فسيصلك الرمز. إذا لم يكن له بريد مفعّل، ${passwordResetSupportSentence(env)}`,
        supportPhone: brand.phoneDisplay,
        supportEmail: brand.supportEmail
    };
};

const createPasswordResetIpLimiter = (max = 8) => rateLimit({
    windowMs: 10 * 60 * 1000,
    max,
    message: {
        success: false,
        code: 'PASSWORD_RESET_RATE_LIMITED',
        error: 'عدد محاولات الاستعادة مرتفع. حاول بعد قليل.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

module.exports = {
    createPasswordResetIpLimiter,
    isolateLtr,
    passwordResetStartBody,
    passwordResetSupportSentence
};
