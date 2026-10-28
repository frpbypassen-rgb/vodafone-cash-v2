'use strict';
// Every explicit admin OTP save wins over any pending self-service enrollment.
module.exports = (account, { keepVerified = false } = {}) => {
    account.emailOtpEnrollment = undefined;
    if (typeof account.markModified === 'function') account.markModified('emailOtpEnrollment');
    if (!keepVerified) {
        account.emailOtpVerifiedEmail = '';
        account.emailOtpVerifiedAt = null;
    }
    if (typeof account.$inc === 'function') account.$inc('emailOtpSettingsRevision', 1);
    else account.emailOtpSettingsRevision = (account.emailOtpSettingsRevision || 0) + 1;
};
