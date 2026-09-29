'use strict';

// Login OTP is opt-in per account. Only an administrator-selected email
// channel can issue a login OTP; all other accounts have OTP disabled.
// WhatsApp remains available to non-login notifications, not login OTP.

const { isDisabled } = require('../config/securityPolicy');
const { isValidEmailAddress, normalizeEmailAddress } = require('./emailAddress');

const isExplicitlyEnabled = (value) => (
    ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
);

/**
 * Login OTP on WhatsApp stays selectable unless the operator turns this
 * older flag off. Unset and 1/true/yes/on keep the selection. 0/false/no/off
 * disable it. The actual send is still blocked unless WHATSAPP_OTP_ENABLED
 * is explicitly on.
 */
const isWhatsappLoginOtpEnabled = (env = process.env) => (
    !isDisabled(env.WHATSAPP_LOGIN_OTP_ENABLED)
);

const isWhatsappOtpEnabled = (env = process.env) => isExplicitlyEnabled(env.WHATSAPP_OTP_ENABLED);

const isEmailOtpEnabled = (env = process.env) => !isDisabled(env.EMAIL_OTP_ENABLED);

const normalizeOtpEmail = normalizeEmailAddress;

const isValidOtpEmail = isValidEmailAddress;

const resolveAccountOtpEmail = (account = {}) => {
    const direct = normalizeOtpEmail(account.email);
    if (direct) return direct;
    const profile = account.businessProfile || {};
    return normalizeOtpEmail(profile.email);
};

const isEmailOtpExplicitlyEnabled = (account = {}) => (
    String(account.otpDeliveryChannel || '').trim().toLowerCase() === 'email'
);

const isLoginOtpEnabledForAccount = (account = {}) => isEmailOtpExplicitlyEnabled(account);

/**
 * @returns {{ channel: 'disabled', code: string } | { channel: 'email', email: string, code?: string }}
 */
const selectLoginOtpChannel = (account = {}, env = process.env) => {
    if (!isEmailOtpExplicitlyEnabled(account)) {
        return { channel: 'disabled', code: 'LOGIN_OTP_NOT_ENABLED' };
    }
    const email = resolveAccountOtpEmail(account);
    if (!isValidOtpEmail(email)) {
        return {
            channel: 'email',
            email: email || '',
            code: 'EMAIL_OTP_ADDRESS_INVALID'
        };
    }
    if (!isEmailOtpEnabled(env)) {
        return { channel: 'email', email, code: 'EMAIL_OTP_DISABLED' };
    }
    return { channel: 'email', email };
};

module.exports = {
    isEmailOtpEnabled,
    isEmailOtpExplicitlyEnabled,
    isLoginOtpEnabledForAccount,
    isValidOtpEmail,
    isWhatsappLoginOtpEnabled,
    isWhatsappOtpEnabled,
    normalizeOtpEmail,
    resolveAccountOtpEmail,
    selectLoginOtpChannel
};
