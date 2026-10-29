'use strict';
// Enrollment codes are separate from login/report codes and excluded from normal reads.
module.exports = {
    emailOtpEnrollment: { type: Object, select: false },
    emailOtpVerifiedEmail: { type: String, default: '' },
    emailOtpVerifiedAt: { type: Date, default: null },
    emailOtpSettingsRevision: { type: Number, default: 0 },
    telegramOtpEnrollment: { type: Object, select: false },
    loginChannelAction: { type: Object, select: false },
    telegramLoginChatId: { type: String, select: false },
    telegramLoginUserId: { type: String, select: false },
    telegramLoginUsername: { type: String, default: '' },
    telegramLoginBotId: { type: String, default: '' },
    telegramLoginVerifiedAt: { type: Date, default: null },
    loginOtpLastSentAt: { type: Date, select: false },
    emailOtpLoginApprovedFor: { type: String, default: '' },
    telegramLoginApprovedFor: { type: String, default: '' },
};
