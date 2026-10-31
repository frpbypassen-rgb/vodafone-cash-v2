'use strict';
const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middlewares/errorHandler');

describe('HTTP error privacy', () => {
    let log;
    beforeEach(() => {
        log = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        log.mockRestore();
    });
    const appFor = (error) => {
        const app = express();
        app.use(express.json());
        app.post('/api/test', (_req, _res, next) => next(error));
        app.use(errorHandler);
        return app;
    };
    test('never writes raw errors, credentials or query text to the response or log', async () => {
        const error = new Error('mongodb://user:private-password@db/finance?token=secret');
        const response = await request(appFor(error)).post('/api/test').send({});
        expect(response.status).toBe(500);
        expect(response.text).not.toMatch(/private-password|mongodb|token=secret/);
        expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-password|mongodb|token=secret/);
        expect(response.headers['cache-control']).toContain('no-store');
    });
    test('malformed JSON is a generic 400, without logging the submitted body', async () => {
        const response = await request(appFor(new Error('unused')))
            .post('/api/test')
            .set('Content-Type', 'application/json')
            .send('{"password":"private-password",');
        expect(response.status).toBe(400);
        expect(response.text).not.toContain('private-password');
        expect(JSON.stringify(log.mock.calls)).not.toContain('private-password');
    });
    test('delegates errors after streaming has begun instead of sending a second response', () => {
        const next = jest.fn();
        const error = new Error('stream failure');
        const res = { headersSent: true, status: jest.fn() };
        errorHandler(error, {}, res, next);
        expect(next).toHaveBeenCalledWith(error);
        expect(res.status).not.toHaveBeenCalled();
    });
});
