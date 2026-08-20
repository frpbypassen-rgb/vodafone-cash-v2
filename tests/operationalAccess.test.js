'use strict';

const express = require('express');
const request = require('supertest');
const {
    isAuthorizedOperationalSocket,
    requireOperationalAccess,
    resolveClientIp
} = require('../middlewares/operationalAccess');

describe('Operational endpoint access', () => {
    const originalToken = process.env.METRICS_AUTH_TOKEN;

    afterEach(() => {
        if (originalToken === undefined) delete process.env.METRICS_AUTH_TOKEN;
        else process.env.METRICS_AUTH_TOKEN = originalToken;
    });

    const createApp = () => {
        const app = express();
        app.get('/metrics', requireOperationalAccess({ tokenEnv: 'METRICS_AUTH_TOKEN' }), (_req, res) => {
            res.send('metrics');
        });
        return app;
    };

    test('allows direct localhost access without a token', async () => {
        await request(createApp()).get('/metrics').expect(200, 'metrics');
    });

    test('denies a forwarded remote client without a token', async () => {
        await request(createApp())
            .get('/metrics')
            .set('X-Forwarded-For', '203.0.113.25')
            .expect(403);
    });

    test('allows a remote client with the configured bearer token', async () => {
        process.env.METRICS_AUTH_TOKEN = 'metrics-token-0123456789-abcdefghijklmnopqrstuvwxyz';
        await request(createApp())
            .get('/metrics')
            .set('X-Forwarded-For', '203.0.113.25')
            .set('Authorization', `Bearer ${process.env.METRICS_AUTH_TOKEN}`)
            .expect(200, 'metrics');
    });

    test('does not trust a spoofed forwarded header from a direct remote peer', () => {
        expect(resolveClientIp({
            peerAddress: '198.51.100.9',
            headers: { 'x-forwarded-for': '127.0.0.1' }
        })).toBe('198.51.100.9');
    });

    test('requires a token for a remote monitor socket', () => {
        process.env.METRICS_AUTH_TOKEN = 'metrics-token-0123456789-abcdefghijklmnopqrstuvwxyz';
        const socket = {
            request: { socket: { remoteAddress: '127.0.0.1' } },
            handshake: {
                headers: { 'x-forwarded-for': '203.0.113.25' },
                auth: { token: process.env.METRICS_AUTH_TOKEN }
            }
        };
        expect(isAuthorizedOperationalSocket(socket, 'METRICS_AUTH_TOKEN')).toBe(true);
        socket.handshake.auth.token = 'wrong-token';
        expect(isAuthorizedOperationalSocket(socket, 'METRICS_AUTH_TOKEN')).toBe(false);
    });
});
