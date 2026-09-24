'use strict';

const { isValidOtpEmail, normalizeOtpEmail } = require('./otpDeliveryChannel');

const ADMIN_EMAIL_REQUIRED_MESSAGE = 'البريد الإلكتروني مطلوب ويجب أن يكون بريداً صالحاً.';

/**
 * Admin-panel create/update requires a valid login email.
 * A valid address is stored and the login OTP channel is set to email.
 * Accounts that have never been given an email stay on the WhatsApp path.
 */
const parseAdminLoginEmail = (value) => {
    const email = normalizeOtpEmail(value);
    if (!isValidOtpEmail(email)) {
        return { ok: false, email: '', message: ADMIN_EMAIL_REQUIRED_MESSAGE };
    }
    return {
        ok: true,
        email,
        otpDeliveryChannel: 'email',
        message: ''
    };
};

module.exports = {
    ADMIN_EMAIL_REQUIRED_MESSAGE,
    parseAdminLoginEmail
};
