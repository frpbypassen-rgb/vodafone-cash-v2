'use strict';

// Login OTP channel.
// Email is used only when the account explicitly sets otpDeliveryChannel to
// "email" and a valid address is stored. Every other account stays on WhatsApp.
// User and agent addresses live on businessProfile.email. The company login
// owner is the ClientEmployee with the canonical owner role, and that address
// is the employee's top-level email. Other company staff, agency staff,
// sub-accounts, and executors also store a top-level email.

const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i;

const normalizeOtpEmail = (value) => String(value || '').trim().toLowerCase();

const isValidOtpEmail = (value) => {
    const email = normalizeOtpEmail(value);
    return email.length > 0 && email.length <= 254 && EMAIL_PATTERN.test(email);
};

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
 * @returns {{ channel: 'whatsapp' } | { channel: 'email', email: string, code?: string }}
 */
const selectLoginOtpChannel = (account = {}) => {
    if (!isEmailOtpExplicitlyEnabled(account)) {
        return { channel: 'whatsapp' };
    }
    const email = resolveAccountOtpEmail(account);
    if (!isValidOtpEmail(email)) {
        return {
            channel: 'email',
            email: '',
            code: 'EMAIL_OTP_ADDRESS_INVALID'
        };
    }
    return { channel: 'email', email };
};

module.exports = {
    isEmailOtpExplicitlyEnabled,
    isValidOtpEmail,
    normalizeOtpEmail,
    resolveAccountOtpEmail,
    selectLoginOtpChannel
};
