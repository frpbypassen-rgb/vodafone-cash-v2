'use strict';
const express = require('express');
const request = require('supertest');
const router = require('../routes/auth');
const { errorHandler } = require('../middlewares/errorHandler');

// Route-boundary regression. The complete session/CSRF/DB path is covered by
// scripts/security-verification/live-app.cjs, not simulated by this small app.
describe('real reset routes with absent request bodies', () => {
    const previous = process.env.PASSWORD_RESET_EMAIL_ENABLED;
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use(errorHandler);
    beforeAll(() => { process.env.PASSWORD_RESET_EMAIL_ENABLED = 'true'; });
    afterAll(() => {
        if (previous === undefined) delete process.env.PASSWORD_RESET_EMAIL_ENABLED;
        else process.env.PASSWORD_RESET_EMAIL_ENABLED = previous;
    });
    test.each(['/api/password-reset/verify-otp', '/api/password-reset/submit'])(
        '%s rejects a missing body as a client error before service work', async route => {
            const response = await request(app).post(route);
            expect(response.status).toBe(400);
            expect(response.body.code).toBe('PASSWORD_RESET_CODE_INVALID');
        }
    );
});
