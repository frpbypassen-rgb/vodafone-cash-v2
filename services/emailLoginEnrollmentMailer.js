'use strict';
const nodemailer = require('nodemailer');
const { getSmtpConfig, getMissingSmtpSettings } = require('./emailOtpMailer');
const { enrollmentEmail } = require('./reportEmailTemplate');
const configured = () => getMissingSmtpSettings(getSmtpConfig()).length === 0;
const sendCode = async (email, code, options) => {
    const config = getSmtpConfig();
    if (!configured()) throw new Error('SMTP_UNAVAILABLE');
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
        const info = await transport.sendMail({
            from: config.from,
            to: email,
            ...enrollmentEmail({ ...options, code }),
        });
        if (!info.accepted?.length) throw new Error('EMAIL_REJECTED');
    } finally {
        transport.close();
    }
};
module.exports = { configured, sendCode };
