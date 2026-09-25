'use strict';

const { classifyEmailAddress, EMAIL_INVALID_MESSAGE, EMAIL_REQUIRED_MESSAGE } = require('./emailAddress');

const ADMIN_EMAIL_REQUIRED_MESSAGE = EMAIL_REQUIRED_MESSAGE;
const ADMIN_EMAIL_INVALID_MESSAGE = EMAIL_INVALID_MESSAGE;

/**
 * Admin-panel create/update requires a valid login email.
 * A valid address is stored lowercase and the login OTP channel is email.
 * An empty value and a malformed value keep separate messages.
 */
const parseAdminLoginEmail = (value) => {
    const parsed = classifyEmailAddress(value);
    if (!parsed.ok) {
        return { ok: false, email: '', code: parsed.code, message: parsed.message };
    }
    return {
        ok: true,
        email: parsed.email,
        otpDeliveryChannel: 'email',
        message: ''
    };
};

module.exports = {
    ADMIN_EMAIL_INVALID_MESSAGE,
    ADMIN_EMAIL_REQUIRED_MESSAGE,
    parseAdminLoginEmail
};
