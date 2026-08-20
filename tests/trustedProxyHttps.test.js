const { normalizeTrustedProxyHttps } = require('../middlewares/trustedProxyHttps');
const express = require('express');
const session = require('express-session');
const request = require('supertest');

const runMiddleware = ({ enabled, headers = {} }) => {
    const req = { headers: { ...headers } };
    const next = jest.fn();
    normalizeTrustedProxyHttps({ enabled })(req, {}, next);
    return { req, next };
};

describe('trusted proxy HTTPS normalization', () => {
    test('supplies HTTPS when TLS is terminated by a trusted proxy without a protocol header', () => {
        const { req, next } = runMiddleware({ enabled: true });

        expect(req.headers['x-forwarded-proto']).toBe('https');
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('preserves an explicit protocol from the proxy', () => {
        const { req } = runMiddleware({
            enabled: true,
            headers: { 'x-forwarded-proto': 'http' }
        });

        expect(req.headers['x-forwarded-proto']).toBe('http');
    });

    test('does not modify requests when proxy HTTPS trust is disabled', () => {
        const { req } = runMiddleware({ enabled: false });

        expect(req.headers['x-forwarded-proto']).toBeUndefined();
    });

    test('allows express-session to issue a secure cookie behind an HTTPS-terminating proxy', async () => {
        const app = express();
        app.set('trust proxy', 1);
        app.use(normalizeTrustedProxyHttps({ enabled: true }));
        app.use(session({
            secret: 'test-session-secret-that-is-long-enough',
            resave: false,
            saveUninitialized: false,
            proxy: true,
            cookie: { secure: true, httpOnly: true, sameSite: 'lax' }
        }));
        app.get('/session', (req, res) => {
            req.session.ready = true;
            res.json({ success: true });
        });

        const response = await request(app).get('/session').expect(200);

        expect(response.headers['set-cookie']?.[0]).toContain('Secure');
    });
});
