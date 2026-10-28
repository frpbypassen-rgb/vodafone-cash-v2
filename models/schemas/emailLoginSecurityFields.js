'use strict';
// Enrollment codes are separate from login/report codes and excluded from normal reads.
module.exports = {
    emailOtpEnrollment: { type: Object, select: false },
    emailOtpVerifiedEmail: { type: String, default: '' },
    emailOtpVerifiedAt: { type: Date, default: null },
    emailOtpSettingsRevision: { type: Number, default: 0 },
};
