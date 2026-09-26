'use strict';

// Login OTP channel.
// A valid stored address uses email unless EMAIL_OTP_ENABLED is explicitly
// off (0/false/no/off). Unset EMAIL_OTP_ENABLED keeps email on. Disabling
// email never selects WhatsApp.
// Accounts with no usable address stay on channel "whatsapp" so
// LOGIN_OTP_SKIP_WITHOUT_EMAIL can still complete password-only login.
// An open WhatsApp send (no code) requires all of:
//   WHATSAPP_LOGIN_OTP_ENABLED is not explicitly off,
//   WHATSAPP_OTP_ENABLED is explicitly 1/true/yes/on (unset is off),
//   OTP_DELIVERY_CHANNEL is not "email".
// WHATSAPP_LOGIN_OTP_ENABLED=false still returns WHATSAPP_LOGIN_OTP_DISABLED
// before the newer flag. OTP_DELIVERY_CHANNEL=email on a no-email account
// returns WHATSAPP_OTP_DISABLED and does not send. Explicit account channel
// "email" with a missing or invalid address stays EMAIL_OTP_ADDRESS_INVALID.
// Receipts, alerts, and support replies do not use this selection.

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

const normalizedDeliveryChannel = (env = process.env) => (
    String(env.OTP_DELIVERY_CHANNEL || '').trim().toLowerCase()
);

/**
 * @returns {{ channel: 'whatsapp', code?: string } | { channel: 'email', email: string, code?: string }}
 */
const selectLoginOtpChannel = (account = {}, env = process.env) => {
    const email = resolveAccountOtpEmail(account);
    if (isValidOtpEmail(email)) {
        if (!isEmailOtpEnabled(env)) {
            return { channel: 'email', email, code: 'EMAIL_OTP_DISABLED' };
        }
        return { channel: 'email', email };
    }
    if (isEmailOtpExplicitlyEnabled(account)) {
        return {
            channel: 'email',
            email: '',
            code: 'EMAIL_OTP_ADDRESS_INVALID'
        };
    }
    if (!isWhatsappLoginOtpEnabled(env)) {
        return { channel: 'whatsapp', code: 'WHATSAPP_LOGIN_OTP_DISABLED' };
    }
    if (!isWhatsappOtpEnabled(env) || normalizedDeliveryChannel(env) === 'email') {
        return { channel: 'whatsapp', code: 'WHATSAPP_OTP_DISABLED' };
    }
    return { channel: 'whatsapp' };
};

module.exports = {
    isEmailOtpEnabled,
    isEmailOtpExplicitlyEnabled,
    isValidOtpEmail,
    isWhatsappLoginOtpEnabled,
    isWhatsappOtpEnabled,
    normalizeOtpEmail,
    resolveAccountOtpEmail,
    selectLoginOtpChannel
};
