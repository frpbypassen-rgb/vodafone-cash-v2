'use strict';

// Password-reset email policy.
// No account model has emailVerified, emailVerifiedAt, or a stored proof that
// the mailbox owner confirmed the address. The admin-controlled signal is
// otpDeliveryChannel === 'email' together with a valid stored address.
// The account editor, registration approval, and the admin login-email
// screens set that channel when they store the address. A well-formed
// address left on the default channel (whatsapp) is not eligible.

const { isValidOtpEmail, resolveAccountOtpEmail } = require('./otpDeliveryChannel');

const isAdminApprovedResetEmail = (account) => {
    if (!account) return false;
    if (String(account.otpDeliveryChannel || '').trim().toLowerCase() !== 'email') return false;
    return isValidOtpEmail(resolveAccountOtpEmail(account));
};

module.exports = {
    isAdminApprovedResetEmail
};
