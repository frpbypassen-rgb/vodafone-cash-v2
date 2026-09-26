'use strict';

const RECIPIENT = 'support@ahrampay.com';

const sendSample = async () => {
    require('dotenv').config();
    // After dotenv, so a false value in .env cannot win. This process does not
    // write .env and does not restart the service.
    process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = 'true';
    const { sendLoginOtpEmail } = require('../services/emailOtpMailer');
    return sendLoginOtpEmail({
        to: RECIPIENT,
        otp: '482913',
        accountName: 'اختبار القالب',
        expiresMinutes: 5,
        year: new Date().getFullYear(),
        attemptAt: new Date(),
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        loginAccount: RECIPIENT
    });
};

if (require.main === module) {
    sendSample().then((result) => {
        const summary = {
            success: Boolean(result && result.success),
            code: result && result.code ? result.code : '',
            messageId: result && result.messageId ? result.messageId : ''
        };
        console.log(JSON.stringify(summary));
        if (!summary.success) process.exitCode = 1;
    }).catch((error) => {
        console.error(error && error.code ? error.code : 'EMAIL_OTP_SEND_FAILED');
        process.exitCode = 1;
    });
}

module.exports = {
    RECIPIENT,
    sendSample
};
