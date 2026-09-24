'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { parseAdminLoginEmail, ADMIN_EMAIL_REQUIRED_MESSAGE } = require('../utils/adminLoginEmail');

describe('admin login email', () => {
    test('accepts a valid address and selects the email OTP channel', () => {
        expect(parseAdminLoginEmail('  Admin@Example.com ')).toEqual({
            ok: true,
            email: 'admin@example.com',
            otpDeliveryChannel: 'email',
            message: ''
        });
    });

    test('rejects a missing or invalid address with the Arabic message used for account owners', () => {
        expect(parseAdminLoginEmail('')).toEqual({
            ok: false,
            email: '',
            message: ADMIN_EMAIL_REQUIRED_MESSAGE
        });
        expect(parseAdminLoginEmail('not-an-email').message).toBe('البريد الإلكتروني مطلوب ويجب أن يكون بريداً صالحاً.');
        expect(parseAdminLoginEmail('a@b.c').ok).toBe(false);
    });

    test('admin verify page names the email channel and keeps the WhatsApp copy for accounts without email', async () => {
        const view = path.join(__dirname, '../views/admin/verify.ejs');
        const emailHtml = await ejs.renderFile(view, { error: null, channel: 'email', csrfToken: 'csrf' });
        const whatsappHtml = await ejs.renderFile(view, { error: 'الرمز غير صحيح أو منتهي الصلاحية.', channel: 'whatsapp', csrfToken: 'csrf' });
        expect(emailHtml).toContain('البريد الإلكتروني المسجّل على حساب الإدارة');
        expect(emailHtml).toContain('action="/admin/verify"');
        expect(whatsappHtml).toContain('واتساب المسجّل على حساب الإدارة');
        expect(whatsappHtml).toContain('الرمز غير صحيح أو منتهي الصلاحية.');
    });

    test('admin management screens require an email and explain the WhatsApp fallback', () => {
        const settings = fs.readFileSync(path.join(__dirname, '../views/settings_users.ejs'), 'utf8');
        const security = fs.readFileSync(path.join(__dirname, '../views/admin_security.ejs'), 'utf8');
        const securityRoute = fs.readFileSync(path.join(__dirname, '../routes/securityAdmin.js'), 'utf8');
        const settingsRoute = fs.readFileSync(path.join(__dirname, '../routes/settings.js'), 'utf8');
        const authRoute = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');

        expect(settings).toContain('البريد الإلكتروني لرمز الدخول');
        expect(settings).toContain('/settings/users/email/');
        expect(settings).toContain('data-required-email="admin"');
        expect(settings).toContain('مسار واتساب يبقى فقط إذا لم يوجد بريد صالح على الحساب.');
        expect(security).toContain('name="email"');
        expect(security).toContain('adminEditorEmail');
        expect(security).toContain('email:f.email.value');
        expect(security).toContain('email:adminEditorEmail.value');
        expect(securityRoute).toContain('parseAdminLoginEmail');
        expect(settingsRoute).toContain("res.redirect('/settings/users?error=email')");
        expect(authRoute).toContain("issueLoginOtp({ account: adminData, accountType: 'admin'");
        expect(authRoute).toContain('continueAdminLogin');
        expect(authRoute).not.toContain('EMERGENCY_CLIENT_OTP_BYPASS=');
    });
});
