'use strict';
const express = require('express');
const request = require('supertest');
const csrf = require('../middlewares/csrfProtection');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { csrfToken: 'test-session-token' }; next(); });
app.use(csrf);
app.post(['/login', '/client/login', '/executor-portal/login', '/admin/change'], (_req, res) => res.json({ success: true }));

describe('login CSRF origin checks', () => {
    test.each(['/login', '/client/login', '/executor-portal/login', '/login/'])(
        'rejects an attacker origin before %s can create a session', async (url) => {
            const response = await request(app).post(url).set('Host', 'pay.example')
                .set('Origin', 'https://attacker.example').send({ username: 'attacker', password: 'irrelevant' });
            expect(response.status).toBe(403);
        }
    );
    test.each([
        { Origin: 'null' },
        { Referer: 'https://attacker.example/login' },
        { 'Sec-Fetch-Site': 'cross-site' },
    ])('rejects an untrusted browser request %j', async (headers) => {
        const response = await request(app).post('/login').set('Host', 'pay.example').set(headers).send({});
        expect(response.status).toBe(403);
    });
    test('accepts a same-origin browser first login without breaking proxy compatibility', async () => {
        const response = await request(app).post('/login').set('Host', 'pay.example')
            .set('Origin', 'https://pay.example').set('Sec-Fetch-Site', 'same-origin').send({});
        expect(response.status).toBe(200);
    });
    test('preserves existing login clients without browser origin metadata', async () => {
        expect((await request(app).post('/login').send({})).status).toBe(200);
    });
    test('still requires a session token on ordinary admin writes', async () => {
        expect((await request(app).post('/admin/change').set('Origin', 'https://pay.example').send({})).status).toBe(403);
        expect((await request(app).post('/admin/change').set('x-csrf-token', 'test-session-token').send({})).status).toBe(200);
    });
});
