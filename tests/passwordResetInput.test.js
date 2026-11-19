'use strict';
const express = require('express');
const request = require('supertest');
const validate = require('../middlewares/passwordResetInput');

describe('password reset input types before handler/service execution', () => {
    let calls;
    const app = express();
    app.use(express.json());
    app.post('/reset', validate(['requestId', 'otp', 'newPassword', 'confirmPassword']), (_req, res) => {
        calls++;
        res.json({ accepted: true });
    });
    beforeEach(() => { calls = 0; });
    test.each([{}, [], 100, true, null, '\0bad'])('rejects malformed value %j without invoking the handler', async value => {
        const r = await request(app).post('/reset').send({ requestId: value });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('PASSWORD_RESET_INPUT_INVALID');
        expect(calls).toBe(0);
    });
    test('valid strings reach the handler', async () => {
        const r = await request(app).post('/reset').send({ requestId: '507f1f77bcf86cd799439011', otp: '482913' });
        expect(r.status).toBe(200);
        expect(calls).toBe(1);
    });
    test('missing optional fields continue to existing required-field checks', async () => {
        expect((await request(app).post('/reset').send({})).status).toBe(200);
        expect(calls).toBe(1);
    });
});
