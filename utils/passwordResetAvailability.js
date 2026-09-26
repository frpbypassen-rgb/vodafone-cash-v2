'use strict';

const { getBrandContact } = require('./brandContact');

const LRM = '\u200E';
const LRI = '\u2066';
const PDI = '\u2069';

const isolateLtr = (value) => `${LRM}${LRI}${value}${PDI}`;

const passwordResetUnavailableMessage = (env = process.env) => {
    const brand = getBrandContact(env);
    return `استعادة كلمة المرور غير متاحة حالياً. تواصل مع الدعم على ${isolateLtr(brand.phoneDisplay)} أو ${isolateLtr(brand.supportEmail)}`;
};

const passwordResetUnavailableBody = (env = process.env) => {
    const brand = getBrandContact(env);
    return {
        success: false,
        code: 'PASSWORD_RESET_UNAVAILABLE',
        error: passwordResetUnavailableMessage(env),
        supportPhone: brand.phoneDisplay,
        supportEmail: brand.supportEmail
    };
};

const respondPasswordResetUnavailable = (req, res) => {
    res.status(503).json(passwordResetUnavailableBody());
};

module.exports = {
    passwordResetUnavailableBody,
    passwordResetUnavailableMessage,
    respondPasswordResetUnavailable
};
