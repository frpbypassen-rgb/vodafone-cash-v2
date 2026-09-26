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
    LOGIN_OTP_LOGO_URL,
    LOGIN_OTP_SUBJECT,
    buildLoginOtpHtml,
    buildLoginOtpText,
    formatArabicMinutes,
    formatLoginAttemptTime,
    maskLoginAccount,
    resetEmailTransport,
    sendLoginOtpEmail,
    summarizeLoginUserAgent
} = require('../services/emailOtpMailer');

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ATTEMPT_AT = new Date('2026-09-22T12:22:00.000Z');
const SAMPLE = {
    otp: '482913',
    accountName: 'عميل تجريبي',
    expiresMinutes: 5,
    year: 2026,
    attemptAt: ATTEMPT_AT,
    userAgent: CHROME_WINDOWS,
    loginAccount: 'tizari@ahram.com'
};

const codeCell = (html) => {
    const match = String(html).match(/letter-spacing:8px;">([^<]*)<\/td>/);
    return match ? match[1] : '';
};

const hrefs = (html) => [...String(html).matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

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

    test('sends multipart/alternative Arabic text and html without the OTP in the subject', async () => {
        process.env.SMTP_HOST = 'smtp.example.net';
        process.env.SMTP_PORT = '587';
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_USER = 'mailer';
        process.env.SMTP_PASS = 'secret-pass';
        const sendMail = jest.fn().mockResolvedValue({ messageId: 'mail-1' });
        nodemailer.createTransport.mockReturnValue({ sendMail });

        const result = await sendLoginOtpEmail({
            to: 'Owner@Example.com',
            ...SAMPLE
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
        expect(DEFAULT_FROM).toBe('أهرام باي <noreply@ahrampay.com>');
        expect(message.to).toBe('owner@example.com');
        expect(message.subject).toBe(LOGIN_OTP_SUBJECT);
        expect(message.subject).toBe('رمز التحقق لتسجيل الدخول — أهرام باي');
        expect(message.subject).not.toContain('482913');
        expect(message.text).toEqual(expect.any(String));
        expect(message.html).toEqual(expect.any(String));
        expect(message.text).toContain('مرحبًا عميل تجريبي،');
        expect(message.text).toContain('رمز التحقق');
        expect(message.text).toContain('482913');
        expect(message.text).toContain('ينتهي خلال 5 دقائق');
        expect(message.text).toContain('تفاصيل المحاولة');
        expect(message.text).toContain('وقت المحاولة: \u200E\u202Aالثلاثاء، 22 سبتمبر 2026 في 14:22\u202C');
        expect(message.text).toContain('الجهاز: \u200E\u202AChrome على Windows\u202C');
        expect(message.text).toContain('الحساب: \u200E\u202Atiz***@ahram.com\u202C');
        expect(message.text).toContain('ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي');
        expect(message.text).toContain('هاتف \u200E\u202A+218 940719000\u202C');
        expect(message.text).toContain('\u200E\u202Asupport@ahrampay.com\u202C');
        expect(message.text).toContain('\u200E\u202Ahttps://ahrampay.com\u202C');
        expect(message.text).not.toContain('tizari@ahram.com');
        expect(message.text).not.toContain('120.0.0.0');
        expect(message.html).toContain('dir="rtl"');
        expect(message.html).toContain('#0c3433');
        expect(message.html).toContain('#c6a04a');
        expect(message.html).toContain('أهرام باي');
        expect(message.html).not.toMatch(/Power Pay|AhramPay|Ahram Pay|AL-Ahram/);
        expect(codeCell(message.html)).toBe('482913');
        expect(JSON.stringify(result)).not.toContain('482913');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('482913');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('482913');
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain('482913');
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
            accountName: '<script>alert(1)</script>',
            year: 2026
        });

        const message = sendMail.mock.calls[0][0];
        expect(message.from).toBe('Desk <desk@example.com>');
        expect(message.html).toContain('مرحبًا <strong style="color:#17211f;">&lt;script&gt;alert(1)&lt;/script&gt;</strong>');
        expect(message.html).not.toContain('<script>');
        expect(message.text).toContain('مرحبًا <script>alert(1)</script>،');

        const hostileHtml = buildLoginOtpHtml({
            otp: '<script>alert(x)</script>',
            accountName: 'عميل',
            userAgent: '<img src=x> ' + CHROME_WINDOWS,
            loginAccount: 'tiz<script>@ahram.com',
            attemptAt: ATTEMPT_AT,
            expiresMinutes: 5,
            year: 2026
        });
        expect(hostileHtml).not.toContain('<script>');
        expect(hostileHtml).not.toContain('src=x');
        expect(hostileHtml).toContain('tiz***@ahram.com');
        expect(hostileHtml).toContain('Chrome على Windows');
        expect(codeCell(hostileHtml)).toBe('');
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

    test.each([
        [1, 'دقيقة واحدة'],
        [2, 'دقيقتين'],
        [5, '5 دقائق'],
        [11, '11 دقيقة'],
        [15, '15 دقيقة']
    ])('uses Arabic minutes grammar for %s (%s) in the message and the preheader', (minutes, phrase) => {
        expect(formatArabicMinutes(minutes)).toBe(phrase);
        const html = buildLoginOtpHtml({ otp: '482913', expiresMinutes: minutes, year: 2026, accountName: 'عميل' });
        const text = buildLoginOtpText({ otp: '482913', expiresMinutes: minutes, accountName: 'عميل' });
        expect(html).toContain(`صالح لمدة ${phrase}.`);
        expect(html).toContain(`ينتهي خلال <strong style="color:#17211f;">${phrase}</strong>`);
        expect(text).toContain(`ينتهي خلال ${phrase}`);
    });

    test('renders attempt details when the server provided them and omits missing rows', () => {
        const withDetails = buildLoginOtpHtml(SAMPLE);
        const text = buildLoginOtpText(SAMPLE);
        expect(formatLoginAttemptTime(ATTEMPT_AT)).toBe('الثلاثاء، 22 سبتمبر 2026 في 14:22');
        expect(withDetails).toContain('تفاصيل المحاولة');
        expect(withDetails).toContain('وقت المحاولة');
        expect(withDetails).toContain('الثلاثاء، 22 سبتمبر 2026 في 14:22');
        expect(withDetails).toContain('Chrome على Windows');
        expect(withDetails).toContain('tiz***@ahram.com');
        expect(withDetails).not.toContain('tizari@ahram.com');
        expect(withDetails).not.toContain('120.0.0.0');
        expect(text).toContain('الحساب: \u200E\u202Atiz***@ahram.com\u202C');

        const withoutDetails = buildLoginOtpHtml({
            otp: '482913',
            accountName: 'عميل تجريبي',
            expiresMinutes: 5,
            year: 2026
        });
        expect(withoutDetails).not.toContain('تفاصيل المحاولة');
        expect(withoutDetails).not.toContain('وقت المحاولة');
        expect(withoutDetails).not.toContain('الجهاز');
        expect(buildLoginOtpText({ otp: '482913', expiresMinutes: 5 })).not.toContain('تفاصيل المحاولة');

        const deviceOnly = buildLoginOtpHtml({
            otp: '482913',
            expiresMinutes: 5,
            year: 2026,
            userAgent: CHROME_WINDOWS
        });
        expect(deviceOnly).toContain('الجهاز');
        expect(deviceOnly).toContain('Chrome على Windows');
        expect(deviceOnly).not.toContain('وقت المحاولة');
        expect(deviceOnly).not.toContain('>الحساب<');
    });

    test('masks email and phone login accounts and ignores values it cannot summarize', () => {
        expect(maskLoginAccount('tizari@ahram.com')).toBe('tiz***@ahram.com');
        expect(maskLoginAccount('Tizari@Ahram.com')).toBe('tiz***@ahram.com');
        expect(maskLoginAccount('0912345678')).toBe('091****678');
        expect(maskLoginAccount('091 234 5678')).toBe('091****678');
        expect(maskLoginAccount('')).toBe('');
        expect(maskLoginAccount('tizari@ahram.com')).not.toBe('tizari@ahram.com');
        expect(summarizeLoginUserAgent(CHROME_WINDOWS)).toBe('Chrome على Windows');
        expect(summarizeLoginUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari على iOS');
        expect(summarizeLoginUserAgent('curl/8.4.0')).toBe('');
        expect(summarizeLoginUserAgent('')).toBe('');
    });

    test('keeps the dark teal design, the official domain, and contact links only', () => {
        const html = buildLoginOtpHtml(SAMPLE);
        const source = fs.readFileSync(path.join(__dirname, '../views/emails/login-otp.ejs'), 'utf8');
        expect(source).not.toContain('<%-');
        expect(source).toContain('<%= otp %>');
        expect(html).toContain('رمز التحقق لتسجيل الدخول | أهرام باي');
        expect(html).toContain('ارجع إلى شاشة تسجيل الدخول المفتوحة في موقع أو تطبيق أهرام باي.');
        expect(html).toContain('الأرقام الستة');
        expect(html).not.toContain('الأرقام الثمانية');
        expect(buildLoginOtpHtml({ otp: '12345678', expiresMinutes: 5, year: 2026 })).toContain('الأرقام الثمانية');
        expect(html).toContain('ahrampay.com');
        expect(html).not.toContain('النطاق الرسمي');
        expect(html).not.toContain('تسجيل آمن');
        expect(html).not.toContain('24 / 7');
        expect(html).toContain(LOGIN_OTP_LOGO_URL);
        expect(html).toContain('alt="أهرام باي"');
        expect(html).not.toContain('>AP</td>');
        expect(html).toContain('تواصل مع أهرام باي');
        expect(html).toContain('<span dir="ltr" style="direction:ltr;unicode-bidi:embed;white-space:nowrap;">© 2026</span> أهرام باي. جميع الحقوق محفوظة.');
        expect(html.match(/جميع الحقوق محفوظة/g)).toHaveLength(1);
        expect(html).toContain('ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي');
        expect(html).toContain('<span dir="ltr" style="direction:ltr;unicode-bidi:embed;">+218 940719000</span>');
        expect(html).toContain('href="tel:+218940719000"');
        expect(html).toContain('<span dir="ltr" style="direction:ltr;unicode-bidi:embed;">support@ahrampay.com</span>');
        expect(html).toContain('<span dir="ltr" style="direction:ltr;unicode-bidi:embed;">https://ahrampay.com</span>');
        expect(html).toContain('<span dir="ltr" style="direction:ltr;unicode-bidi:embed;white-space:nowrap;">tiz***@ahram.com</span>');
        expect(html).toContain('<span dir="ltr" style="direction:ltr;unicode-bidi:embed;white-space:nowrap;">الثلاثاء، 22 سبتمبر 2026 في 14:22</span>');
        const phoneMask = buildLoginOtpHtml({
            otp: '482913',
            expiresMinutes: 5,
            year: 2026,
            loginAccount: '0912345678'
        });
        expect(phoneMask).toContain('<span dir="ltr" style="direction:ltr;unicode-bidi:embed;white-space:nowrap;">091****678</span>');
        expect(buildLoginOtpText({ otp: '482913', expiresMinutes: 5, loginAccount: '0912345678' })).toContain('\u200E\u202A091****678\u202C');
        expect(hrefs(html)).toEqual([
            'mailto:support@ahrampay.com',
            'tel:+218940719000',
            'https://ahrampay.com'
        ]);
        expect(html).not.toContain('<button');
        expect(html).not.toContain('display:flex');
        expect(html).not.toContain('display:grid');
        expect(codeCell(buildLoginOtpHtml({ otp: '482 913', expiresMinutes: 5, year: 2026 }))).toBe('482913');

        const fallback = buildLoginOtpHtml({ otp: '482913', expiresMinutes: 5, year: 2026, logo: null });
        expect(fallback).toContain('>AP</td>');
        expect(fallback).not.toContain(LOGIN_OTP_LOGO_URL);
    });

    test('checked-in preview matches the html builder', () => {
        const html = buildLoginOtpHtml(SAMPLE);
        const preview = fs.readFileSync(path.join(__dirname, '../design-previews/login-otp-email.html'), 'utf8');
        expect(preview).toBe(html);
        expect(preview).toContain('dir="rtl"');
        expect(preview).toContain('عميل تجريبي');
        expect(codeCell(preview)).toBe('482913');
    });

    test('falls back to a greeting without a name', () => {
        const text = buildLoginOtpText({ otp: '111222', expiresMinutes: 5 });
        expect(text.startsWith('أهرام باي')).toBe(true);
        expect(text).toContain('مرحبًا بك،');
        expect(text).not.toContain('مرحبًا ،');
    });
});
