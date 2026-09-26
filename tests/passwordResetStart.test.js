'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const {
    passwordResetUnavailableBody,
    respondPasswordResetUnavailable
} = require('../utils/passwordResetAvailability');

const LRI = '\u2066';
const PDI = '\u2069';

describe('password reset start', () => {
    const previous = {
        phone: process.env.BRAND_PHONE_DISPLAY,
        email: process.env.BRAND_SUPPORT_EMAIL
    };

    afterEach(() => {
        if (previous.phone === undefined) delete process.env.BRAND_PHONE_DISPLAY;
        else process.env.BRAND_PHONE_DISPLAY = previous.phone;
        if (previous.email === undefined) delete process.env.BRAND_SUPPORT_EMAIL;
        else process.env.BRAND_SUPPORT_EMAIL = previous.email;
    });

    test('returns the same unavailable message whether or not an account exists', async () => {
        delete process.env.BRAND_PHONE_DISPLAY;
        delete process.env.BRAND_SUPPORT_EMAIL;
        const app = express();
        app.use(express.json());
        app.post('/api/password-reset/start', respondPasswordResetUnavailable);

        const known = await request(app).post('/api/password-reset/start').send({
            username: 'known-user',
            phone: '0911111111'
        });
        const unknown = await request(app).post('/api/password-reset/start').send({
            username: 'missing-user',
            phone: '0922222222'
        });
        const empty = await request(app).post('/api/password-reset/start').send({});

        expect(known.status).toBe(503);
        expect(known.body).toEqual(unknown.body);
        expect(known.body).toEqual(empty.body);
        expect(known.body).toEqual(passwordResetUnavailableBody());
        expect(known.body.code).toBe('PASSWORD_RESET_UNAVAILABLE');
        expect(known.body.success).toBe(false);
        expect(known.body.supportPhone).toBe('0913731533');
        expect(known.body.supportEmail).toBe('support@ahrampay.com');
        expect(known.body.error).toBe(
            `استعادة كلمة المرور غير متاحة حالياً. تواصل مع الدعم على \u200E${LRI}0913731533${PDI} أو \u200E${LRI}support@ahrampay.com${PDI}`
        );
        expect(known.body).not.toHaveProperty('otp');
        expect(known.body).not.toHaveProperty('requestId');
        expect(known.body.error).not.toContain('واتساب');
        expect(known.headers['set-cookie']).toBeUndefined();
    });

    test('reads the phone and email from the central brand config', () => {
        process.env.BRAND_PHONE_DISPLAY = '0910000000';
        process.env.BRAND_SUPPORT_EMAIL = 'help@example.com';
        const body = passwordResetUnavailableBody();
        expect(body.supportPhone).toBe('0910000000');
        expect(body.supportEmail).toBe('help@example.com');
        expect(body.error).toContain(`${LRI}0910000000${PDI}`);
        expect(body.error).toContain(`${LRI}help@example.com${PDI}`);
    });

    test('the start route does not send WhatsApp, store a hash, or open a session', () => {
        const auth = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
        const start = auth.slice(
            auth.indexOf("router.post('/api/password-reset/start'"),
            auth.indexOf("router.post('/api/password-reset/verify-otp'")
        );
        expect(start).toContain('respondPasswordResetUnavailable');
        expect(start).not.toContain('sendOtp');
        expect(start).not.toContain('hashOtp');
        expect(start).not.toContain('generateOtp');
        expect(start).not.toContain('PasswordResetRequest');
        expect(start).not.toContain('req.session');
        expect(start).not.toContain('findPasswordResetAccount');

        const page = fs.readFileSync(path.join(__dirname, '../views/unified_login.ejs'), 'utf8');
        expect(page).toContain("details.code === 'PASSWORD_RESET_UNAVAILABLE'");
        expect(page).toContain("node.dir = 'ltr'");
        expect(page).toContain("node.style.unicodeBidi = 'isolate'");
        expect(page).toContain('setResetStatus(error.message, \'error\', error)');
        expect(page).not.toContain('box.innerHTML');
    });
});
