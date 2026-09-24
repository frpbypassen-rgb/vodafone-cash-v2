'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { isValidOtpEmail, normalizeOtpEmail } = require('../utils/otpDeliveryChannel');

const DEFAULT_FROM = 'Ahram Pay <noreply@ahrampay.com>';
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET', 'ECONNREFUSED']);

let transportCache = { key: '', transport: null };

const isEnabledFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const getSmtpConfig = (env = process.env) => {
    const host = String(env.SMTP_HOST || '').trim();
    const parsedPort = Number(env.SMTP_PORT);
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
        ? parsedPort
        : 587;
    const rawSecure = String(env.SMTP_SECURE ?? '').trim().toLowerCase();
    const secure = rawSecure === '' ? port === 465 : isEnabledFlag(rawSecure);
    const user = String(env.SMTP_USER || '').trim();
    const pass = env.SMTP_PASS == null ? '' : String(env.SMTP_PASS);
    const from = String(env.SMTP_FROM || '').trim() || DEFAULT_FROM;
    return { host, port, secure, user, pass, from };
};

const getMissingSmtpSettings = (config) => {
    const missing = [];
    if (!config.host) missing.push('SMTP_HOST');
    if (!config.user) missing.push('SMTP_USER');
    if (!config.pass) missing.push('SMTP_PASS');
    return missing;
};

const resetEmailTransport = () => {
    transportCache = { key: '', transport: null };
};

const getTransport = (config) => {
    const key = [config.host, config.port, config.secure ? '1' : '0', config.user, config.pass].join('\n');
    if (transportCache.transport && transportCache.key === key) return transportCache.transport;
    const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
            user: config.user,
            pass: config.pass
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
    });
    transportCache = { key, transport };
    return transport;
};

const buildLoginOtpText = ({ otp, expiresMinutes, accountName }) => {
    const name = String(accountName || '').replace(/[\r\n]+/g, ' ').trim();
    const greeting = name ? `مرحباً ${name}،` : 'مرحباً،';
    const minutes = Math.max(1, Number(expiresMinutes) || 5);
    return [
        greeting,
        '',
        `رمز التحقق لتسجيل الدخول: ${otp}`,
        '',
        `صلاحية الرمز: ${minutes} دقائق.`,
        '',
        'لا تشارك هذا الرمز مع أي شخص. لن يطلبه منك فريق أهرام باي.',
        'إذا لم تطلب تسجيل الدخول، تجاهل هذه الرسالة.'
    ].join('\n');
};

const failure = (code) => ({
    success: false,
    provider: 'smtp',
    channel: 'email',
    code
});

const sendLoginOtpEmail = async ({ to, otp, expiresMinutes = 5, accountName = '' } = {}) => {
    const email = normalizeOtpEmail(to);
    if (!isValidOtpEmail(email)) return failure('EMAIL_OTP_ADDRESS_INVALID');

    const config = getSmtpConfig();
    const missing = getMissingSmtpSettings(config);
    if (missing.length) {
        logger.security('login email otp config missing', {
            code: 'SMTP_CONFIG_MISSING',
            missing
        });
        return failure('SMTP_CONFIG_MISSING');
    }

    try {
        const transport = getTransport(config);
        const info = await transport.sendMail({
            from: config.from,
            to: email,
            subject: 'رمز التحقق لتسجيل الدخول',
            text: buildLoginOtpText({ otp, expiresMinutes, accountName })
        });
        return {
            success: true,
            provider: 'smtp',
            channel: 'email',
            messageId: info && info.messageId ? String(info.messageId) : ''
        };
    } catch (error) {
        const smtpCode = error && error.code ? String(error.code).slice(0, 40) : '';
        const code = TIMEOUT_CODES.has(smtpCode) ? 'EMAIL_OTP_TIMEOUT' : 'EMAIL_OTP_SEND_FAILED';
        logger.security('login email otp failed', { code, smtpCode });
        return failure(code);
    }
};

module.exports = {
    DEFAULT_FROM,
    buildLoginOtpText,
    getMissingSmtpSettings,
    getSmtpConfig,
    resetEmailTransport,
    sendLoginOtpEmail
};
