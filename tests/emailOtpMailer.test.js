'use strict';

const fs = require('fs');
const path = require('path');

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
    LOGIN_OTP_SUBJECT,
    buildLoginOtpHtml,
    buildLoginOtpText,
    formatLoginOtpExpiresAt,
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

    test('sends a multipart Arabic OTP message and never logs the raw code', async () => {
        process.env.SMTP_HOST = 'smtp.example.net';
        process.env.SMTP_PORT = '587';
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_USER = 'mailer';
        process.env.SMTP_PASS = 'secret-pass';
        const sendMail = jest.fn().mockResolvedValue({ messageId: 'mail-1' });
        nodemailer.createTransport.mockReturnValue({ sendMail });
        const expiresAt = new Date('2026-09-22T12:22:00.000Z');

        const result = await sendLoginOtpEmail({
            to: 'Owner@Example.com',
            otp: '654321',
            expiresMinutes: 5,
            expiresAt,
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
        expect(message.subject).toBe(LOGIN_OTP_SUBJECT);
        expect(message.text).toContain('مرحباً شركة الأهرام،');
        expect(message.text).toContain('رمز الدخول الآمن');
        expect(message.text).toContain('رمز التحقق');
        expect(message.text).toContain('654321');
        expect(message.text).toContain('تنتهي صلاحية هذا الرمز في 22-09-2026 14:22');
        expect(message.text).toContain('لا تشارك الرمز مع أحد');
        expect(message.text).toContain('ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي');
        expect(message.text).toContain('هاتف +218 940719000');
        expect(message.text).toContain('support@ahrampay.com');
        expect(message.text).toContain('مع أطيب التحيات ، فريق أهرام باي');
        expect(message.html).toContain('dir="rtl"');
        expect(message.html).toContain('width="600"');
        expect(message.html).toContain('أهرام باي');
        expect(message.html).toContain('Ahram Pay');
        expect(message.html).toContain('رمز الدخول الآمن');
        expect(message.html).toContain('#F7F1E8');
        expect(message.html).toContain('#C9A227');
        expect(message.html).toContain('لا تشارك الرمز مع أحد');
        expect(message.html).toContain('ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي');
        expect(message.html).toContain('https://ahrampay.com');
        expect(message.html).toContain('© 2027 شركة الاهرام للاتصالات والتقنية. جميع الحقوق محفوظة.');
        const tiles = [...message.html.matchAll(/text-align:center;">(\d)<\/td>/g)].map((match) => match[1]);
        expect(tiles.join('')).toBe('654321');
        expect(JSON.stringify(result)).not.toContain('654321');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('654321');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('654321');
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain('654321');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain(message.html);
    });

    test('keeps the SMTP_FROM override and escapes the account name in html', async () => {
        process.env.SMTP_HOST = 'smtp.example.net';
        process.env.SMTP_USER = 'mailer';
        process.env.SMTP_PASS = 'secret-pass';
        process.env.SMTP_FROM = 'Desk <desk@example.com>';
        const sendMail = jest.fn().mockResolvedValue({ messageId: 'mail-2' });
        nodemailer.createTransport.mockReturnValue({ sendMail });

        await sendLoginOtpEmail({
            to: 'owner@example.com',
            otp: '654321',
            accountName: '<script>alert(1)</script>'
        });

        const message = sendMail.mock.calls[0][0];
        expect(message.from).toBe('Desk <desk@example.com>');
        expect(message.html).toContain('مرحباً &lt;script&gt;alert(1)&lt;/script&gt;،');
        expect(message.html).not.toContain('<script>');
        expect(message.text).toContain('مرحباً <script>alert(1)</script>،');

        const hostileHtml = buildLoginOtpHtml({
            otp: '<script>',
            accountName: 'عميل',
            expiresAt: new Date('2026-09-22T12:22:00.000Z')
        });
        expect(hostileHtml).not.toContain('<script>');
        expect(hostileHtml).toContain('&lt;');
        expect(hostileHtml).toContain('&gt;');
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

    test('builds the Arabic body with the Tripoli expiry and a do-not-share warning', () => {
        const expiresAt = new Date('2026-09-22T12:22:00.000Z');
        const text = buildLoginOtpText({ otp: '111222', expiresAt, accountName: 'عميل' });
        const html = buildLoginOtpHtml({ otp: '111222', expiresAt, accountName: 'عميل' });
        expect(formatLoginOtpExpiresAt(expiresAt)).toBe('22-09-2026 14:22');
        expect(text).toContain('مرحباً عميل،');
        expect(text).toContain('111222');
        expect(text).toContain('تنتهي صلاحية هذا الرمز في 22-09-2026 14:22');
        expect(text).toContain('لا تشارك الرمز مع أحد');
        expect(text).toContain('+218 940719000');
        expect(html).toContain('dir="rtl"');
        expect(html).toContain('رمز الدخول الآمن');
        expect(html).toContain('#F7F1E8');
        expect(html).toContain('background:#F8E8C4');
        const tiles = [...html.matchAll(/text-align:center;">(\d)<\/td>/g)].map((match) => match[1]);
        expect(tiles.join('')).toBe('111222');
        expect(html).not.toContain('font-family:Georgia');
        expect(html).not.toContain('display:flex');
        expect(html).not.toContain('display:grid');
        expect(html).not.toMatch(/>\)<\/td>/);
        expect(html).not.toContain('صلاحية الرمز: 5 دقائق');
        expect(html).not.toContain('<script>');
    });

    test('checked-in preview matches the html builder', () => {
        const html = buildLoginOtpHtml({
            otp: '745874',
            accountName: 'محمد',
            expiresAt: new Date('2026-09-22T12:22:00.000Z')
        });
        const preview = fs.readFileSync(path.join(__dirname, '../design-previews/login-otp-email.html'), 'utf8');
        expect(preview).toBe(html);
        expect(preview).toContain('dir="rtl"');
        expect(preview).toContain('رمز الدخول الآمن');
        const tiles = [...preview.matchAll(/text-align:center;">(\d)<\/td>/g)].map((match) => match[1]);
        expect(tiles.join('')).toBe('745874');
    });

    test('falls back to a greeting without a name', () => {
        const text = buildLoginOtpText({ otp: '111222', expiresAt: new Date('2026-09-22T12:22:00.000Z') });
        expect(text.startsWith('أهرام باي')).toBe(true);
        expect(text).toContain('مرحباً،');
        expect(text).not.toContain('مرحباً ،');
    });
});
