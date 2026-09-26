'use strict';

const fs = require('fs');
const path = require('path');
const { OTP_DIGITS, hashOtp, normalizeSubmittedOtp, verifyOtp } = require('../utils/otp');

describe('OTP security', () => {
    const originalOtpSecret = process.env.OTP_SECRET;

    beforeAll(() => {
        process.env.OTP_SECRET = 'test-otp-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
    });

    afterAll(() => {
        if (originalOtpSecret === undefined) delete process.env.OTP_SECRET;
        else process.env.OTP_SECRET = originalOtpSecret;
    });

    test('accepts only the OTP matching its HMAC digest', () => {
        const digest = hashOtp('482913');
        expect(verifyOtp('482913', digest)).toBe(true);
        expect(verifyOtp('482914', digest)).toBe(false);
    });

    test('rejects plaintext and malformed OTP storage', () => {
        expect(verifyOtp('200104', '200104')).toBe(false);
        expect(verifyOtp('12345', hashOtp('12345'))).toBe(false);
        expect(verifyOtp('1234567', hashOtp('1234567'))).toBe(false);
    });

    test('strips whitespace and non-digits before verifying a login OTP', () => {
        const digest = hashOtp('482913');
        expect(normalizeSubmittedOtp(' 482 913 ')).toBe('482913');
        expect(normalizeSubmittedOtp('482-913')).toBe('482913');
        expect(normalizeSubmittedOtp('48a2913')).toBe('482913');
        expect(verifyOtp(' 482 913 ', digest)).toBe(true);
        expect(verifyOtp('482-913', digest)).toBe(true);
        expect(verifyOtp('48a2913', digest)).toBe(true);
        expect(verifyOtp('482 914', digest)).toBe(false);
        expect(verifyOtp('48291', digest)).toBe(false);
    });

    test('login OTP fields on every portal strip non-digits before submit', () => {
        const script = fs.readFileSync(path.join(__dirname, '../views/partials/login_otp_field_script.ejs'), 'utf8');
        expect(OTP_DIGITS).toBe(6);
        expect(script).toContain(".replace(/\\D/g, '').slice(0, 6)");
        const views = [
            '../views/client/verify.ejs',
            '../views/executor/verify.ejs',
            '../views/admin/verify.ejs'
        ];
        views.forEach((view) => {
            const html = fs.readFileSync(path.join(__dirname, view), 'utf8');
            expect(html).toContain('data-login-otp');
            expect(html).toContain("include('../partials/login_otp_field_script')");
            expect(html).not.toContain('maxlength="6"');
        });
        const client = fs.readFileSync(path.join(__dirname, '../controllers/clientAuthController.js'), 'utf8');
        const executor = fs.readFileSync(path.join(__dirname, '../controllers/executorAuthController.js'), 'utf8');
        const auth = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
        expect(client).toContain('normalizeSubmittedOtp(req.body.otp)');
        expect(executor).toContain('normalizeSubmittedOtp(req.body.otp)');
        expect(auth).toContain('normalizeSubmittedOtp(req.body.otp)');
    });

    test('stores only the HMAC, and mail failure does not open a session or log the code', () => {
        const { sanitizeLogValue } = require('../utils/logSanitizer');
        const service = fs.readFileSync(path.join(__dirname, '../services/loginOtpService.js'), 'utf8');
        const mailer = fs.readFileSync(path.join(__dirname, '../services/emailOtpMailer.js'), 'utf8');
        const auth = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
        const channel = fs.readFileSync(path.join(__dirname, '../utils/otpDeliveryChannel.js'), 'utf8');
        const defaults = fs.readFileSync(path.join(__dirname, '../config/productionSecurityDefaults.js'), 'utf8');
        expect(service).toContain('otpCode: hashOtp(otp)');
        expect(service).not.toMatch(/otpCode:\s*otp\b/);
        expect(service).toContain('new Date(Date.now() + 5 * 60 * 1000)');
        expect(service).toContain('OTP_RESEND_COOLDOWN_SECONDS');
        expect(service).toContain('clearStoredOtp');
        expect(mailer).not.toContain('Sentry');
        expect(mailer).toContain('redactLoginOtp');
        expect(mailer).toContain("logger.security('login email otp failed', { code, smtpCode })");
        expect(mailer).not.toContain('error.stack');
        expect(channel).not.toContain('LOGIN_OTP_EMAIL_TEMPLATE_V2');
        expect(defaults).not.toContain('LOGIN_OTP_EMAIL_TEMPLATE_V2');
        expect(sanitizeLogValue('482913', 'otp')).toBe('[REDACTED]');
        expect(sanitizeLogValue('482913', 'otpCode')).toBe('[REDACTED]');

        const executor = fs.readFileSync(path.join(__dirname, '../controllers/executorAuthController.js'), 'utf8');
        const startClient = auth.slice(auth.indexOf('const startClientOtp'), auth.indexOf('const continueVerifiedPortalLogin'));
        const startAdmin = auth.slice(auth.indexOf('const startAdminOtp'), auth.indexOf('router.post(\'/admin/verify\''));
        const startExecutor = executor.slice(executor.indexOf('const startExecutorOtp'), executor.indexOf('const continueExecutorAfterPassword'));
        [startClient, startAdmin, startExecutor].forEach((block) => {
            const guard = block.indexOf("if (issued.status !== 'sent')");
            const session = block.indexOf('establishAuthenticatedSession');
            expect(guard).toBeGreaterThan(-1);
            expect(session).toBeGreaterThan(guard);
        });
        expect(auth).toContain("return renderLogin(res, 'بيانات الدخول غير صحيحة.'");
        expect(auth).not.toContain('البريد غير مسجل');

        const client = fs.readFileSync(path.join(__dirname, '../controllers/clientAuthController.js'), 'utf8');
        expect(client).toContain('otpAttempts');
        expect(client).toContain('>= 5');
        expect(client).toContain('otpCode: 1');
    });
});
