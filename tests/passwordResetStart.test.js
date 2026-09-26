'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { createPasswordResetIpLimiter, passwordResetStartBody } = require('../utils/passwordResetAvailability');

describe('password reset start response', () => {
    test('limits repeated starts from the same IP', async () => {
        const app = express();
        app.set('trust proxy', false);
        app.use(express.json());
        app.post('/api/password-reset/start', createPasswordResetIpLimiter(2), (req, res) => {
            res.json(passwordResetStartBody('same-shape'));
        });
        const first = await request(app).post('/api/password-reset/start').send({ username: 'a', phone: '1' });
        const second = await request(app).post('/api/password-reset/start').send({ username: 'b', phone: '2' });
        const third = await request(app).post('/api/password-reset/start').send({ username: 'c', phone: '3' });
        expect(first.status).toBe(200);
        expect(second.body.message).toBe(first.body.message);
        expect(third.status).toBe(429);
        expect(third.body.code).toBe('PASSWORD_RESET_RATE_LIMITED');
        expect(third.body.error).not.toMatch(/\d{6}/);
    });

    test('the route delegates to the email service and the page isolates the support line', () => {
        const auth = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
        const start = auth.slice(
            auth.indexOf("router.post('/api/password-reset/start'"),
            auth.indexOf("router.post('/api/password-reset/verify-otp'")
        );
        expect(start).toContain('startPasswordReset');
        expect(start).not.toContain('sendOtp');
        expect(start).not.toContain('req.session');
        const page = fs.readFileSync(path.join(__dirname, '../views/unified_login.ejs'), 'utf8');
        expect(page).toContain("details.code === 'PASSWORD_RESET_UNAVAILABLE' || details.code === 'PASSWORD_RESET_STARTED'");
        expect(page).toContain("node.style.unicodeBidi = 'isolate'");
        const doc = fs.readFileSync(path.join(__dirname, '../docs/operations/password-reset.md'), 'utf8');
        expect(doc).toContain('0913731533');
        expect(doc).toContain('support@ahrampay.com');
        expect(doc).toContain('WHATSAPP_OTP_ENABLED');
    });
});
