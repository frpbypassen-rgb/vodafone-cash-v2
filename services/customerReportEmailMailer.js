'use strict';
const nodemailer = require('nodemailer');
const { codeEmail, statementEmail } = require('./reportEmailTemplate');
const { getSmtpConfig, getMissingSmtpSettings } = require('./emailOtpMailer');
const configured = () => getMissingSmtpSettings(getSmtpConfig()).length === 0;
const send = async (message) => {
    if (!configured())
        throw Object.assign(new Error('البريد غير مهيأ على الخادم حالياً.'), {
            code: 'SMTP_UNAVAILABLE',
            statusCode: 503,
        });
    const config = getSmtpConfig();
    const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
    });
    try {
        const info = await transport.sendMail({ from: config.from, ...message });
        if (!info.accepted?.length) throw Object.assign(new Error('EMAIL_REJECTED'), { code: 'EENVELOPE' });
        return info;
    } finally {
        transport.close();
    }
};
const sendCode = (email, code, { accountName = '' } = {}) =>
    send({ to: email, ...codeEmail({ code, kind: 'customer', accountName }) });
const sendStatement = (options) =>
    send({ to: options.email, ...statementEmail({ ...options, kind: 'customer' }) });
module.exports = { configured, sendCode, sendStatement };
