'use strict';
const express = require('express');
const request = require('supertest');
const { createLoginLimiter, validateLoginInput } = require('../middlewares/webLoginProtection');

describe('web login boundary', () => {
    const appFor = (limited = false) => {
        const app = express();
        app.use(express.json());
        if (limited) app.use(createLoginLimiter());
        app.post('/login', validateLoginInput, (_req, res) => res.send('invalid credentials'));
        return app;
    };
    test('counts login failures even when a legacy form renders HTTP 200', async () => {
        const app = appFor(true);
        for (let index = 0; index < 10; index++) {
            expect(
                (await request(app).post('/login').send({ username: 'test', password: 'wrong' })).status
            ).toBe(200);
        }
        expect((await request(app).post('/login').send({ username: 'test', password: 'wrong' })).status).toBe(
            429
        );
    });
    test.each([
        { username: { $ne: null }, password: 'valid' },
        { username: ['one', 'two'], password: 'valid' },
        { webUsername: 'valid', webPassword: { $regex: '.*' } },
        { username: 'a'.repeat(255), password: 'valid' },
        { username: 'valid', password: 'a'.repeat(1025) },
    ])('rejects malformed credential fields before account lookup: %j', async (body) => {
        expect((await request(appFor()).post('/login').send(body)).status).toBe(400);
    });
    test.each([{ webUsername: 'test', webPassword: 'normal password' }, { otp: '123456' }])(
        'preserves legacy aliases and pending MFA submissions',
        async (body) => {
            expect((await request(appFor()).post('/login').send(body)).status).toBe(200);
        }
    );
});
