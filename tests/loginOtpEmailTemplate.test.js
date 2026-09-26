'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { buildLoginOtpHtmlV2 } = require('../services/emailOtpMailer');

const LOGO_URL = 'https://ahrampay.com/images/login-otp-logo.jpg';
const SAMPLE = {
    otp: '482913',
    accountName: 'عميل تجريبي',
    expiresMinutes: 5,
    year: 2026,
    attemptAt: new Date('2026-09-22T12:22:00.000Z'),
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    loginAccount: 'tizari@ahram.com'
};

const previousFlag = process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2;

afterAll(() => {
    if (previousFlag === undefined) delete process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2;
    else process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = previousFlag;
});

test('serves login-otp-logo.jpg as a real JPEG', async () => {
    const app = express();
    app.use(express.static(path.join(__dirname, '../public')));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/images/login-otp-logo.jpg`);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(response.status).toBe(200);
        expect(String(response.headers.get('content-type'))).toMatch(/^image\/jpeg\b/);
        expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
        expect(bytes.length).toBeGreaterThan(1000);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('documents the template flag, brand env, and the single support recipient', () => {
    const example = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../scripts/sendLoginOtpTemplateV2Sample.js'), 'utf8');
    const doc = fs.readFileSync(path.join(__dirname, '../docs/operations/login-otp-email.md'), 'utf8');
    [
        'LOGIN_OTP_EMAIL_TEMPLATE_V2=false',
        'BRAND_NAME=أهرام باي',
        'BRAND_SUPPORT_EMAIL=support@ahrampay.com',
        'BRAND_PHONE=+218940719000',
        'BRAND_PHONE_DISPLAY=+218 94 071 9000',
        'BRAND_ADDRESS=',
        'BRAND_WEBSITE=https://ahrampay.com'
    ].forEach((line) => expect(example).toContain(line));
    expect(script).toContain("const RECIPIENT = 'support@ahrampay.com'");
    expect(script).toContain("process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = 'true'");
    expect(script.indexOf("require('dotenv').config()")).toBeLessThan(script.indexOf("process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = 'true'"));
    expect(script).not.toContain('customer@');
    expect(doc).toContain('NXDOMAIN');
    expect(doc).toContain('v=spf1');
    expect(doc).toContain('default._domainkey.ahrampay.com');
    expect(doc).toContain('node .\\scripts\\sendLoginOtpTemplateV2Sample.js');
});

test('the dark template fits 320px and 600px and every image loads', async () => {
    const previous = process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2;
    delete process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2;
    const html = buildLoginOtpHtmlV2(SAMPLE);
    if (previous === undefined) delete process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2;
    else process.env.LOGIN_OTP_EMAIL_TEMPLATE_V2 = previous;

    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    const srcs = [...html.matchAll(/\ssrc="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(srcs).toEqual([LOGO_URL]);
    hrefs.forEach((href) => {
        expect(href).toMatch(/^(mailto:[^\s@]+@[^\s@]+|tel:\+\d{8,15}|https:\/\/[^\s]+)$/);
    });

    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/checkLoginOtpEmailLayout.js')], {
        encoding: 'utf8',
        timeout: 50000
    });
    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || 'layout check failed');
    }
    const report = JSON.parse(result.stdout);
    for (const width of [320, 600]) {
        const box = report.widths[width];
        expect(box.cardWidth).toBeLessThanOrEqual(width);
        expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
        expect(box.longScrollWidth).toBeLessThanOrEqual(box.longClientWidth + 1);
        expect(box.phone).toBe('+218 94 071 9000');
        expect(box.plus).toBeLessThan(box.digits);
        expect(box.images).toEqual([
            expect.objectContaining({ complete: true })
        ]);
        expect(box.images[0].src.startsWith('data:image/jpeg;base64,')).toBe(true);
        expect(box.images[0].naturalWidth).toBeGreaterThan(0);
        expect(box.links).toEqual(hrefs);
    }
}, 60000);
