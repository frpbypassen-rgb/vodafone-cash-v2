'use strict';
jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));
const express = require('express');
const request = require('supertest');
const logger = require('../utils/logger');
const requestLogger = require('../middlewares/requestLogger');
const appFor = (code, path = '/api/mobile/refresh-token', status = 403) => {
    const app = express();
    app.use(requestLogger);
    app.post(path, (_req, res) =>
        res
            .status(status)
            .json({
                success: false,
                code,
                refreshToken: 'secret-response-token',
                message: 'private-message',
            }),
    );
    return app;
};
beforeEach(() => jest.clearAllMocks());
test('logs bounded mobile authentication reason and PID without altering response or leaking tokens', async () => {
    const response = await request(appFor('SESSION_REVOKED'))
        .post('/api/mobile/refresh-token')
        .set('Authorization', 'Bearer private-access-token')
        .send({ refreshToken: 'private-refresh-token' })
        .expect(403);
    expect(response.body).toEqual({
        success: false,
        code: 'SESSION_REVOKED',
        refreshToken: 'secret-response-token',
        message: 'private-message',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const log = logger.warn.mock.calls[0][1];
    expect(log).toMatchObject({
        authErrorCode: 'SESSION_REVOKED',
        pid: process.pid,
        statusCode: 403,
    });
    expect(JSON.stringify(log)).not.toMatch(
        /private-|secret-response-token|Bearer/,
    );
});
test('never records arbitrary response codes or messages as authentication diagnostics', async () => {
    await request(appFor('TOKEN_secret-value'))
        .post('/api/mobile/refresh-token')
        .expect(403);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn.mock.calls[0][1]).not.toHaveProperty('authErrorCode');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
        'secret-value',
    );
});
test('does not label a successful response or unrelated endpoint as a failed mobile session', async () => {
    await request(appFor('TOKEN_EXPIRED', '/other', 403))
        .post('/other')
        .expect(403);
    await request(appFor('TOKEN_EXPIRED', '/api/mobile/refresh-token', 200))
        .post('/api/mobile/refresh-token')
        .expect(200);
    await new Promise((resolve) => setImmediate(resolve));
    for (const [, log] of [
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
    ])
        expect(log).not.toHaveProperty('authErrorCode');
});
