'use strict';

// Login OTP channel.
// A valid stored address uses email. WhatsApp remains only when no usable
// address is stored (legacy accounts that have not been given an email yet)
// and WHATSAPP_LOGIN_OTP_ENABLED is unset or truthy. An explicit falsy value
// (0/false/no/off) blocks login OTP on WhatsApp only; receipts, alerts, and
// support replies are unaffected. If the account explicitly selects email but
// the address is missing or invalid, delivery fails instead of falling back
// to WhatsApp.
// LOGIN_OTP_SKIP_WITHOUT_EMAIL does not change this selection. When that
// flag is on, loginOtpService treats a whatsapp selection as "no usable
// email" and completes login without sending.
// User and agent addresses live on businessProfile.email. The company login
// owner is the ClientEmployee with the canonical owner role, and that address
// is the employee's top-level email. Other company staff, agency staff,
// sub-accounts, executors, and admin accounts also store a top-level email.

const { isDisabled } = require('../config/securityPolicy');
const { isValidEmailAddress, normalizeEmailAddress } = require('./emailAddress');

/**
 * Login OTP on WhatsApp stays available unless the operator turns it off.
 * Unset and 1/true/yes/on keep today's path. 0/false/no/off disable it.
 */
const isWhatsappLoginOtpEnabled = (env = process.env) => (
    !isDisabled(env.WHATSAPP_LOGIN_OTP_ENABLED)
);

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

/**
 * @returns {{ channel: 'whatsapp', code?: string } | { channel: 'email', email: string, code?: string }}
 */
const selectLoginOtpChannel = (account = {}, env = process.env) => {
    const email = resolveAccountOtpEmail(account);
    if (isValidOtpEmail(email)) {
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
    return { channel: 'whatsapp' };
};

module.exports = {
    isEmailOtpExplicitlyEnabled,
    isValidOtpEmail,
    isWhatsappLoginOtpEnabled,
    normalizeOtpEmail,
    resolveAccountOtpEmail,
    selectLoginOtpChannel
};
