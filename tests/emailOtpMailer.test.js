'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

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
    buildLoginOtpHtmlV2,
    buildLoginOtpText,
    buildLoginOtpTextV2,
    formatArabicMinutes,
    formatLoginAttemptTime,
    maskLoginAccount,
    resetEmailTransport,
    sendLoginOtpEmail,
    summarizeLoginUserAgent
} = require('../services/emailOtpMailer');
const legacyTemplate = require('../services/emailOtpTemplateLegacy');

const ENV_KEYS = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'LOGIN_OTP_EMAIL_TEMPLATE_V2',
    'BRAND_NAME',
    'BRAND_SUPPORT_EMAIL',
    'BRAND_PHONE_TEL',
    'BRAND_PHONE_DISPLAY',
    'BRAND_ADDRESS',
    'BRAND_WEBSITE'
];
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
const LEGACY_SAMPLE = {
    otp: '482913',
    accountName: 'عميل تجريبي',
    expiresMinutes: 5,
    expiresAt: ATTEMPT_AT
};
const BDO = '<bdo dir="ltr" style="unicode-bidi:isolate;">';
const LTR = (value) => `\u200E\u2066${value}\u2069`;

const codeCell = (html) => {
    const match = String(html).match(/letter-spacing:8px;"><bdo dir="ltr" style="unicode-bidi:isolate;">([^<]*)<\/bdo>/);
    return match ? match[1] : '';
};

const hrefs = (html) => [...String(html).matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
const srcs = (html) => [...String(html).matchAll(/\ssrc="([^"]*)"/g)].map((match) => match[1]);

describe('email OTP mailer', () => {
    let previousEnv;

    beforeEach(() => {
        previousEnv = {};
        ENV_KEYS.forEach((key) => {
            previousEnv[key] = process.env[key];
            delete process.env[key];
        });
        resetEmailTransport();
        jest.clearAllMocks();
    });

    afterEach(() => {
        ENV_KEYS.forEach((key) => {
            if (previousEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnv[key];
        });
        resetEmailTransport();
    });

    const enableV2 = () => {
        process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = 'true';
    };

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

    test('keeps the current template and From header when the v2 flag is off', async () => {
        process.env.SMTP_HOST = 'smtp.example.net';
        process.env.SMTP_PORT = '587';
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_USER = 'mailer';
        process.env.SMTP_PASS = 'secret-pass';
        const sendMail = jest.fn().mockResolvedValue({ messageId: 'mail-legacy' });
        nodemailer.createTransport.mockReturnValue({ sendMail });

        const result = await sendLoginOtpEmail({
            to: 'Owner@Example.com',
            ...SAMPLE,
            expiresAt: ATTEMPT_AT
        });

        expect(result.success).toBe(true);
        const message = sendMail.mock.calls[0][0];
        expect(message.from).toBe('Ahram Pay <noreply@ahrampay.com>');
        expect(DEFAULT_FROM).toBe('Ahram Pay <noreply@ahrampay.com>');
        expect(message.to).toBe('owner@example.com');
        expect(message.subject).toBe(LOGIN_OTP_SUBJECT);
        expect(message.subject).not.toContain('482913');
        expect(message.html).toBe(legacyTemplate.buildLoginOtpHtml({ ...SAMPLE, expiresAt: ATTEMPT_AT }));
        expect(message.text).toBe(legacyTemplate.buildLoginOtpText({ ...SAMPLE, expiresAt: ATTEMPT_AT }));
        expect(message.html).toContain('#F7F1E8');
        expect(message.html).toContain('#C9A227');
        expect(message.html).not.toContain('#0c3433');
        expect(message.html).toContain('href="tel:0913731533"');
        expect(message.html).toContain('>0913731533</a>');
        expect(message.text).toContain('هاتف 0913731533');
        expect(message.html).not.toContain('+218');
        expect(message.text).not.toContain('+218');
        expect(message.html).not.toContain('تفاصيل المحاولة');
        expect(message.text).toContain('مرحباً عميل تجريبي،');
        expect(message.text).toContain('482913');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('482913');
        expect(JSON.stringify(result)).not.toContain('482913');
    });

    test.each(['', 'false', '0', 'off', 'no'])('treats LOGIN_OTP_EMAIL_TEMPLATE_V2=%j as the current template', (value) => {
        if (value) process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = value;
        const html = buildLoginOtpHtml(LEGACY_SAMPLE);
        expect(html).toContain('#C9A227');
        expect(html).not.toContain('#0c3433');
    });

    test('sends the dark template only when LOGIN_OTP_EMAIL_TEMPLATE_V2 is on', async () => {
        enableV2();
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
        const message = sendMail.mock.calls[0][0];
        expect(message.from).toBe('أهرام باي <noreply@ahrampay.com>');
        expect(message.to).toBe('owner@example.com');
        expect(message.subject).toBe('رمز التحقق لتسجيل الدخول — أهرام باي');
        expect(message.subject).not.toContain('482913');
        expect(message.text).toContain('مرحبًا عميل تجريبي،');
        expect(message.text).toContain('رمز التحقق');
        expect(message.text).toContain(LTR('482913'));
        expect(message.text).toContain('ينتهي خلال 5 دقائق');
        expect(message.text).toContain('تفاصيل المحاولة');
        expect(message.text).toContain(`وقت المحاولة: ${LTR('الثلاثاء، 22 سبتمبر 2026 في 14:22')}`);
        expect(message.text).toContain(`الجهاز: ${LTR('Chrome على Windows')}`);
        expect(message.text).toContain(`الحساب: ${LTR('tiz***@ahram.com')}`);
        expect(message.text).toContain('ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي');
        expect(message.text).toContain(`هاتف ${LTR('0913731533')}`);
        expect(message.text).toContain(LTR('support@ahrampay.com'));
        expect(message.text).toContain(LTR('https://ahrampay.com'));
        expect(message.text).toContain('طريقة استخدام الرمز');
        expect(message.text).toContain('نصائح لحماية حسابك');
        expect(message.text).not.toContain('tizari@ahram.com');
        expect(message.text).not.toContain('120.0.0.0');
        expect(message.html).toContain('dir="rtl"');
        expect(message.html).toContain('#0c3433');
        expect(message.html).toContain('#c6a04a');
        expect(message.html).toContain('أهرام باي');
        expect(message.html).not.toMatch(/Power Pay|AhramPay|Ahram Pay|AL-Ahram/);
        expect(codeCell(message.html)).toBe('482913');
        expect(message.html).not.toContain('482 913');
        expect(JSON.stringify(result)).not.toContain('482913');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('482913');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('482913');
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain('482913');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain(message.html);
    });

    test('sends the current template when the new template fails to render', async () => {
        enableV2();
        process.env.SMTP_HOST = 'smtp.example.net';
        process.env.SMTP_USER = 'mailer';
        process.env.SMTP_PASS = 'secret-pass';
        const sendMail = jest.fn().mockResolvedValue({ messageId: 'mail-fallback' });
        nodemailer.createTransport.mockReturnValue({ sendMail });
        const render = jest.spyOn(ejs, 'render').mockImplementation(() => {
            throw new Error('template exploded 654321');
        });

        try {
            const result = await sendLoginOtpEmail({
                to: 'owner@example.com',
                otp: '654321',
                accountName: 'عميل',
                expiresMinutes: 5,
                expiresAt: ATTEMPT_AT,
                year: 2026
            });

            expect(result).toEqual({
                success: true,
                provider: 'smtp',
                channel: 'email',
                messageId: 'mail-fallback'
            });
            const message = sendMail.mock.calls[0][0];
            expect(message.html).toContain('#F7F1E8');
            expect(message.html).toContain('#C9A227');
            expect(message.html).not.toContain('#0c3433');
            expect(message.text).toContain('654321');
            expect(message.html).toContain('>6</td>');
            expect(message.html).toContain('>1</td>');
            expect(message.html).toBe(legacyTemplate.buildLoginOtpHtml({
                otp: '654321',
                accountName: 'عميل',
                expiresMinutes: 5,
                expiresAt: ATTEMPT_AT,
                year: 2026
            }));
            const logged = JSON.stringify(logger.security.mock.calls);
            expect(logged).toContain('LOGIN_OTP_TEMPLATE_V2_RENDER_FAILED');
            expect(logged).toContain('[REDACTED]');
            expect(logged).not.toContain('654321');
            expect(logged).not.toContain(message.html);
            expect(JSON.stringify(logger.error.mock.calls)).not.toContain('654321');
            expect(JSON.stringify(logger.info.mock.calls)).not.toContain('654321');
            expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('654321');
        } finally {
            render.mockRestore();
        }
    });

    test('still sends the new template when the logo file cannot be read', async () => {
        enableV2();
        process.env.SMTP_HOST = 'smtp.example.net';
        process.env.SMTP_USER = 'mailer';
        process.env.SMTP_PASS = 'secret-pass';
        const sendMail = jest.fn().mockResolvedValue({ messageId: 'mail-logo' });
        nodemailer.createTransport.mockReturnValue({ sendMail });
        const realReadFileSync = fs.readFileSync.bind(fs);
        const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
            if (String(filePath).includes('login-otp-logo')) throw new Error('logo disk 654321');
            return realReadFileSync(filePath, ...args);
        });

        try {
            const result = await sendLoginOtpEmail({
                to: 'owner@example.com',
                otp: '654321',
                expiresMinutes: 5,
                year: 2026
            });
            expect(result.success).toBe(true);
            const message = sendMail.mock.calls[0][0];
            expect(message.html).toContain('#0c3433');
            expect(message.html).toContain(`src="${LOGIN_OTP_LOGO_URL}"`);
            expect(message.html).toContain('alt="أهرام باي"');
            expect(JSON.stringify(logger.security.mock.calls)).not.toContain('654321');
            expect(JSON.stringify(result)).not.toContain('654321');
        } finally {
            readFile.mockRestore();
        }
    });

    test('keeps the SMTP_FROM override and escapes the account name in html', async () => {
        enableV2();
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

        const hostileHtml = buildLoginOtpHtmlV2({
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
        expect(result.success).toBe(false);
        expect(JSON.stringify(result)).not.toContain('654321');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('654321');
        expect(JSON.stringify(logger.security.mock.calls)).not.toContain('rejected 654321');
        expect(logger.security).toHaveBeenCalledWith('login email otp failed', {
            code: 'EMAIL_OTP_SEND_FAILED',
            smtpCode: 'EAUTH'
        });
    });

    test.each([
        [1, 'دقيقة واحدة'],
        [2, 'دقيقتين'],
        [3, '3 دقائق'],
        [5, '5 دقائق'],
        [10, '10 دقائق'],
        [11, '11 دقيقة'],
        [15, '15 دقيقة']
    ])('uses Arabic minutes grammar for %s (%s) in the message and the preheader', (minutes, phrase) => {
        enableV2();
        expect(formatArabicMinutes(minutes)).toBe(phrase);
        const html = buildLoginOtpHtml({ otp: '482913', expiresMinutes: minutes, year: 2026, accountName: 'عميل' });
        const text = buildLoginOtpText({ otp: '482913', expiresMinutes: minutes, accountName: 'عميل' });
        expect(html).toContain(`صالح لمدة ${phrase}.`);
        expect(html).toContain(`ينتهي خلال <strong style="color:#17211f;">${phrase}</strong>`);
        expect(text).toContain(`ينتهي خلال ${phrase}`);
    });

    test('renders long and short Arabic names without dropping the code', () => {
        enableV2();
        const longName = `عبدالرحمن ${'بن '.repeat(12)}التجريبي الطويل`;
        const shortName = 'م';
        const longHtml = buildLoginOtpHtmlV2({ ...SAMPLE, accountName: longName });
        const shortHtml = buildLoginOtpHtmlV2({ ...SAMPLE, accountName: shortName });
        expect(longHtml).toContain(longName);
        expect(shortHtml).toContain('>م<');
        expect(codeCell(longHtml)).toBe('482913');
        expect(codeCell(shortHtml)).toBe('482913');
        expect(buildLoginOtpTextV2({ ...SAMPLE, accountName: longName })).toContain(`مرحبًا ${longName}،`);
        expect(buildLoginOtpTextV2({ ...SAMPLE, accountName: shortName })).toContain('مرحبًا م،');
    });

    test('renders attempt details when the server provided them and omits missing rows', () => {
        enableV2();
        const withDetails = buildLoginOtpHtml(SAMPLE);
        const text = buildLoginOtpText(SAMPLE);
        expect(formatLoginAttemptTime(ATTEMPT_AT)).toBe('الثلاثاء، 22 سبتمبر 2026 في 14:22');
        expect(withDetails).toContain('تفاصيل المحاولة');
        expect(withDetails).toContain('وقت المحاولة');
        expect(withDetails).toContain(`${BDO}الثلاثاء، 22 سبتمبر 2026 في 14:22</bdo>`);
        expect(withDetails).toContain(`${BDO}Chrome على Windows</bdo>`);
        expect(withDetails).toContain(`${BDO}tiz***@ahram.com</bdo>`);
        expect(withDetails).not.toContain('tizari@ahram.com');
        expect(withDetails).not.toContain('120.0.0.0');
        expect(text).toContain(`الحساب: ${LTR('tiz***@ahram.com')}`);

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

    test('reads brand contact from one config and isolates LTR values', () => {
        enableV2();
        process.env.BRAND_NAME = 'اسم طويل للتجربة المالية';
        process.env.BRAND_SUPPORT_EMAIL = 'help@example.com';
        process.env.BRAND_PHONE_TEL = '0910000000';
        process.env.BRAND_PHONE_DISPLAY = '0910000000';
        process.env.BRAND_ADDRESS = 'عنوان تجريبي قصير';
        process.env.BRAND_WEBSITE = 'https://example.com/app';
        const html = buildLoginOtpHtml(SAMPLE);
        const text = buildLoginOtpText(SAMPLE);
        const source = fs.readFileSync(path.join(__dirname, '../views/emails/login-otp.ejs'), 'utf8');
        expect(source).not.toContain('<%-');
        expect(source).not.toContain('أهرام باي');
        expect(source).not.toContain('ahrampay.com');
        expect(source).not.toContain('+218');
        expect(html).toContain('اسم طويل للتجربة المالية');
        expect(html).toContain('عنوان تجريبي قصير');
        expect(html).toContain(`${BDO}0910000000</bdo>`);
        expect(html).toContain('href="tel:0910000000"');
        expect(html).toContain(`${BDO}help@example.com</bdo>`);
        expect(html).toContain(`${BDO}https://example.com/app</bdo>`);
        expect(html).toContain(`${BDO}example.com</bdo>`);
        expect(html).toContain('src="https://example.com/images/login-otp-logo.jpg"');
        expect(text).toContain(LTR('0910000000'));
        expect(text).toContain('اسم طويل للتجربة المالية');
    });

    test('keeps the dark template contact links and a six-digit code without spaces', () => {
        enableV2();
        const html = buildLoginOtpHtml(SAMPLE);
        const source = fs.readFileSync(path.join(__dirname, '../views/emails/login-otp.ejs'), 'utf8');
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
        expect(html).toContain(`${BDO}© 2026</bdo> أهرام باي. جميع الحقوق محفوظة.`);
        expect(html.match(/جميع الحقوق محفوظة/g)).toHaveLength(1);
        expect(html).toContain('ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي');
        expect(html).toMatch(/<a href="tel:0913731533" style="color:#f0d687;text-decoration:none;font-size:13px;"><bdo dir="ltr" style="unicode-bidi:isolate;">0913731533<\/bdo><\/a>/);
        expect(html).toContain(`${BDO}support@ahrampay.com</bdo>`);
        expect(html).toContain(`${BDO}https://ahrampay.com</bdo>`);
        expect(html).toContain(`${BDO}tiz***@ahram.com</bdo>`);
        expect(hrefs(html)).toEqual([
            'mailto:support@ahrampay.com',
            'tel:0913731533',
            'https://ahrampay.com'
        ]);
        expect(srcs(html)).toEqual([LOGIN_OTP_LOGO_URL]);
        hrefs(html).forEach((href) => {
            expect(href).toMatch(/^(mailto:[^\s@]+@[^\s@]+|tel:\+?\d{8,15}|https:\/\/[^\s]+)$/);
        });
        srcs(html).forEach((src) => {
            expect(src).toMatch(/^https:\/\/[^\s]+$/);
        });
        expect(html).not.toContain('<button');
        expect(html).not.toContain('display:flex');
        expect(html).not.toContain('display:grid');
        expect(codeCell(buildLoginOtpHtml({ otp: '482 913', expiresMinutes: 5, year: 2026 }))).toBe('482913');
        expect(codeCell(html)).not.toMatch(/\s/);

        const phoneMask = buildLoginOtpHtml({
            otp: '482913',
            expiresMinutes: 5,
            year: 2026,
            loginAccount: '0912345678'
        });
        expect(phoneMask).toContain(`${BDO}091****678</bdo>`);
        expect(buildLoginOtpText({ otp: '482913', expiresMinutes: 5, loginAccount: '0912345678' })).toContain(LTR('091****678'));

        const fallback = buildLoginOtpHtml({ otp: '482913', expiresMinutes: 5, year: 2026, logo: null });
        expect(fallback).toContain('>AP</td>');
        expect(fallback).not.toContain(LOGIN_OTP_LOGO_URL);
        expect(srcs(fallback)).toEqual([]);
    });

    test('checked-in previews match the builders', () => {
        const legacyHtml = buildLoginOtpHtml(LEGACY_SAMPLE);
        const legacyPreview = fs.readFileSync(path.join(__dirname, '../design-previews/login-otp-email.html'), 'utf8');
        expect(legacyPreview).toBe(legacyHtml);
        expect(legacyPreview).toContain('#F7F1E8');

        enableV2();
        const html = buildLoginOtpHtml(SAMPLE);
        const preview = fs.readFileSync(path.join(__dirname, '../design-previews/login-otp-email-v2.html'), 'utf8');
        expect(preview).toBe(html);
        expect(preview).toContain('dir="rtl"');
        expect(preview).toContain('عميل تجريبي');
        expect(codeCell(preview)).toBe('482913');
    });

    test('falls back to a greeting without a name', () => {
        enableV2();
        const text = buildLoginOtpText({ otp: '111222', expiresMinutes: 5 });
        expect(text.startsWith('أهرام باي')).toBe(true);
        expect(text).toContain('مرحبًا بك،');
        expect(text).not.toContain('مرحبًا ،');
    });
});
