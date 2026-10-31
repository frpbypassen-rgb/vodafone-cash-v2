'use strict';

const cors = require('cors');
const express = require('express');
const request = require('supertest');
const {
    getAllowedOrigins,
    getMobileAllowedOrigins,
    MOBILE_WEB_PREVIEW_ORIGINS
} = require('../config/corsOrigins');

describe('CORS origin configuration', () => {
    test('does not authorize an unrelated website to read credentialed API responses', async () => {
        const app = express();
        app.use(cors({ origin: getAllowedOrigins('https://ahrampay.com'), credentials: true }));
        app.get('/api/test', (_req, res) => res.json({ ok: true }));
        const response = await request(app).get('/api/test').set('Origin', 'https://untrusted.example');
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('preserves server-to-server API access without an Origin header', async () => {
        const app = express();
        app.use(cors({ origin: getAllowedOrigins('https://ahrampay.com'), credentials: true }));
        app.get('/api/test', (_req, res) => res.json({ ok: true }));
        expect((await request(app).get('/api/test')).body).toEqual({ ok: true });
    });
    test('keeps the configured public origins unchanged for the main website', () => {
        expect(getAllowedOrigins('https://ahrampay.com, https://admin.ahrampay.com')).toEqual([
            'https://ahrampay.com',
            'https://admin.ahrampay.com'
        ]);
    });

    test('allows Flutter web preview only on the mobile API origin list', () => {
        const publicOrigins = getAllowedOrigins('https://ahrampay.com');
        const mobileOrigins = getMobileAllowedOrigins('https://ahrampay.com');

        expect(publicOrigins).toEqual(['https://ahrampay.com']);
        expect(mobileOrigins).toEqual([
            'https://ahrampay.com',
            ...MOBILE_WEB_PREVIEW_ORIGINS
        ]);
    });

    test('returns CORS headers for Flutter web preview on mobile API preflight', async () => {
        const app = express();
        app.use('/api/mobile', cors({
            origin: getMobileAllowedOrigins('https://ahrampay.com'),
            credentials: true
        }));

        const response = await request(app)
            .options('/api/mobile/login')
            .set('Origin', 'http://127.0.0.1:3001')
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'content-type');

        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3001');
        expect(response.headers['access-control-allow-credentials']).toBe('true');
    });
});
