'use strict';

jest.mock('nodemailer', () => ({
    createTransport: jest.fn()
}));
jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    security: jest.fn()
}));

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const {
    DEFAULT_FROM,
    buildLoginOtpText,
    resetEmailTransport,
    sendLoginOtpEmail
} = require('../services/emailOtpMailer');

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

describe('email OTP mailer', () => {
    let previousEnv;

    beforeEach(() => {
        previousEnv = {};
        SMTP_KEYS.forEach((key) => {
            previousEnv[key] = process.env[key];
            delete process.env[key];
        });
        resetEmailTransport();
        jest.clearAllMocks();
    });

    afterEach(() => {
        SMTP_KEYS.forEach((key) => {
            if (previousEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnv[key];
        });
        resetEmailTransport();
    });

    test('returns a public config error and does not open SMTP when settings are missing', async () => {
        const result = await sendLoginOtpEmail({
            to: 'owner@example.com',
            otp: '654321',
            expiresMinutes: 5
        });
        expect(result).toEqual({
            success: false,
            provider: 'smtp',
            channel: 'email',
            code: 'SMTP_CONFIG_MISSING'
        });
        expect(nodemailer.createTransport).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('654321');
    });

    test('sends a plain Arabic OTP message and never logs the raw code', async () => {
        process.env.SMTP_HOST = 'smtp.example.net';
        process.env.SMTP_PORT = '587';
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_USER = 'mailer';
        process.env.SMTP_PASS = 'secret-pass';
        const sendMail = jest.fn().mockResolvedValue({ messageId: 'mail-1' });
        nodemailer.createTransport.mockReturnValue({ sendMail });

        const result = await sendLoginOtpEmail({
            to: 'Owner@Example.com',
            otp: '654321',
            expiresMinutes: 5,
            accountName: 'شركة الأهرام'
        });

        expect(result).toEqual({
            success: true,
            provider: 'smtp',
            channel: 'email',
            messageId: 'mail-1'
        });
        expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
            host: 'smtp.example.net',
            port: 587,
            secure: false,
            auth: { user: 'mailer', pass: 'secret-pass' }
        }));
        const message = sendMail.mock.calls[0][0];
        expect(message.from).toBe(DEFAULT_FROM);
        expect(message.to).toBe('owner@example.com');
        expect(message.subject).toBe('رمز التحقق لتسجيل الدخول');
        expect(message.text).toContain('رمز التحقق لتسجيل الدخول: 654321');
        expect(message.text).toContain('صلاحية الرمز: 5 دقائق.');
        expect(message.text).toContain('لا تشارك هذا الرمز مع أي شخص');
        expect(message.html).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('654321');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('654321');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('654321');
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain('654321');
    });

    test('hides the raw OTP when SMTP rejects the message', async () => {
        process.env.SMTP_HOST = 'smtp.example.net';
        process.env.SMTP_USER = 'mailer';
        process.env.SMTP_PASS = 'secret-pass';
        const sendMail = jest.fn().mockRejectedValue(Object.assign(new Error('rejected 654321'), { code: 'EAUTH' }));
        nodemailer.createTransport.mockReturnValue({ sendMail });

        const result = await sendLoginOtpEmail({
            to: 'owner@example.com',
            otp: '654321',
            expiresMinutes: 5
        });

        expect(result.code).toBe('EMAIL_OTP_SEND_FAILED');
        expect(JSON.stringify(result)).not.toContain('654321');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('654321');
        expect(logger.security).toHaveBeenCalledWith('login email otp failed', {
            code: 'EMAIL_OTP_SEND_FAILED',
            smtpCode: 'EAUTH'
        });
    });

    test('builds the Arabic body with the expiry and a do-not-share warning', () => {
        const text = buildLoginOtpText({ otp: '111222', expiresMinutes: 5, accountName: 'عميل' });
        expect(text).toContain('111222');
        expect(text).toContain('5 دقائق');
        expect(text).toContain('لا تشارك');
    });
});
