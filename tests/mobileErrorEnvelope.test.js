// tests/mobileErrorEnvelope.test.js
// ===============================================
// 🧪 Contract Tests — تنسيق الأخطاء الموحد على مسارات Mobile API الفعلية
// ===============================================
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-that-is-long-enough-32chars';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-key-long-enough-32chars';

const request = require('supertest');
const express = require('express');

jest.mock('express-rate-limit', () => () => (req, res, next) => next());

const app = express();
app.use(express.json());
app.use('/api/mobile', require('../routes/mobileApi'));

const expectMobileErrorEnvelope = (body) => {
    expect(body.success).toBe(false);
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThan(0);
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(typeof body.correlationId).toBe('string');
    expect(body.correlationId.length).toBeGreaterThan(0);
    expect(body.error).toBeUndefined();
    expect(body.stack).toBeUndefined();
};

describe('🚨 Error Envelope: Real Mobile API Routes', () => {
    test('POST /api/mobile/login validation error should use the official envelope', async () => {
        const res = await request(app)
            .post('/api/mobile/login')
            .set('X-Correlation-Id', 'corr-login-validation')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(res.body.correlationId).toBe('corr-login-validation');
        expectMobileErrorEnvelope(res.body);
    });

    test('GET /api/mobile/client/home without token should use the official envelope', async () => {
        const res = await request(app)
            .get('/api/mobile/client/home')
            .set('X-Correlation-Id', 'corr-missing-token');

        expect(res.status).toBe(401);
        expect(res.body.code).toBe('TOKEN_INVALID');
        expect(res.body.correlationId).toBe('corr-missing-token');
        expectMobileErrorEnvelope(res.body);
    });

    test('GET unknown /api/mobile route should use the official 404 envelope', async () => {
        const res = await request(app)
            .get('/api/mobile/route-that-does-not-exist')
            .set('X-Correlation-Id', 'corr-not-found');

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
        expect(res.body.correlationId).toBe('corr-not-found');
        expectMobileErrorEnvelope(res.body);
    });
});
