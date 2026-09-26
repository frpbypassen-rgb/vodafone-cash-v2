'use strict';

const RECIPIENT = 'support@ahrampay.com';

const emailsIn = (value) => {
    const matches = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig);
    return matches || [];
};

const collectRequestedRecipients = (argv = []) => {
    const found = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = String(argv[index] || '');
        if (arg === '--to' || arg === '-To' || arg === '-to') {
            found.push(...emailsIn(argv[index + 1]));
            index += 1;
            continue;
        }
        if (arg.startsWith('--to=')) {
            found.push(...emailsIn(arg.slice('--to='.length)));
            continue;
        }
        found.push(...emailsIn(arg));
    }
    return found;
};

const assertTemplateParameter = (argv = []) => {
    const index = argv.findIndex((item) => item === '--template' || item === '-Template');
    const value = index >= 0 ? String(argv[index + 1] || '') : '';
    if (value.toLowerCase() !== 'v2') {
        const error = new Error('TEMPLATE_PARAMETER_REQUIRED');
        error.code = 'TEMPLATE_PARAMETER_REQUIRED';
        throw error;
    }
};

const assertRecipientAllowed = (argv = [], explicitTo = '') => {
    const requested = [...collectRequestedRecipients(argv), ...emailsIn(explicitTo)];
    const foreign = requested.filter((item) => item.toLowerCase() !== RECIPIENT);
    if (foreign.length) {
        const error = new Error('RECIPIENT_REFUSED');
        error.code = 'RECIPIENT_REFUSED';
        throw error;
    }
};

const sendSample = async (options = {}) => {
    const argv = options.argv || process.argv.slice(2);
    assertTemplateParameter(argv);
    assertRecipientAllowed(argv, options.to);
    require('dotenv').config();
    // After dotenv, so a false value in .env cannot win. This process does not
    // write .env and does not restart the service. The only recipient is fixed.
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
    sendSample({ argv: process.argv.slice(2) }).then((result) => {
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
