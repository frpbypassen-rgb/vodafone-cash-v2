'use strict';
const express = require('express');
const request = require('supertest');
const rateLimit = require('../utils/requestRateLimit');
const { normalizeRateLimitIp } = require('../utils/requestRateLimit');
const { readTrustProxy } = require('../config/trustedProxy');
const appFor = (options = {}, trust = 'loopback') => {
    const app = express();
    app.set('trust proxy', trust);
    app.use(
        rateLimit({
            windowMs: 60000,
            limit: 2,
            standardHeaders: true,
            legacyHeaders: false,
            ...options,
        }),
    );
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    return app;
};
test('IIS IPv4 ports cannot reset a visitor quota, without rewriting request IP or device identity', async () => {
    const app = appFor();
    await request(app)
        .get('/')
        .set('X-Forwarded-For', '203.0.113.9:19522')
        .expect(200, { ip: '203.0.113.9:19522' });
    await request(app)
        .get('/')
        .set('X-Forwarded-For', '203.0.113.9:29700')
        .expect(200);
    await request(app)
        .get('/')
        .set('X-Forwarded-For', '203.0.113.9:60000')
        .expect(429);
    await request(app)
        .get('/')
        .set('X-Forwarded-For', '203.0.113.10:60000')
        .expect(200);
});
test('IPv6 addresses remain intact, bracketed endpoints normalize and /56 quota protection remains', async () => {
    expect(normalizeRateLimitIp('2001:db8::abcd:1234')).toBe(
        '2001:db8::abcd:1234',
    );
    expect(normalizeRateLimitIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeRateLimitIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    const app = appFor({ limit: 1 });
    await request(app)
        .get('/')
        .set('X-Forwarded-For', '[2001:db8:1234:5600::1]:1234')
        .expect(200);
    await request(app)
        .get('/')
        .set('X-Forwarded-For', '[2001:db8:1234:56ff::2]:4321')
        .expect(429);
});
test('untrusted forwarded headers cannot replace the socket identity', async () => {
    const app = appFor({ limit: 1 }, false);
    await request(app)
        .get('/')
        .set('X-Forwarded-For', '203.0.113.8:1111')
        .expect(200);
    await request(app)
        .get('/')
        .set('X-Forwarded-For', '203.0.113.9:2222')
        .expect(429);
});
test('invalid addresses fail into a shared socket quota rather than attacker-controlled buckets', async () => {
    for (const ip of [
        'bad-ip',
        '1.2.3.4:99999',
        '[2001:db8::1]:99999',
        '1.2.3.4, 5.6.7.8',
        '',
    ])
        expect(normalizeRateLimitIp(ip)).toBe('');
    const app = appFor({ limit: 1 });
    await request(app).get('/').set('X-Forwarded-For', 'bad-first').expect(200);
    await request(app)
        .get('/')
        .set('X-Forwarded-For', 'bad-second')
        .expect(429);
});
test('explicit account key generators and configured limits retain their semantics', async () => {
    const app = appFor({
        limit: 1,
        keyGenerator: (req) => req.get('X-Test-Account'),
    });
    await request(app).get('/').set('X-Test-Account', 'account-a').expect(200);
    await request(app).get('/').set('X-Test-Account', 'account-b').expect(200);
    await request(app).get('/').set('X-Test-Account', 'account-a').expect(429);
});
test('proxy configuration preserves the current default and accepts explicit trusted networks', () => {
    expect(readTrustProxy({})).toBe(1);
    expect(readTrustProxy({ TRUST_PROXY: 'false' })).toBe(false);
    expect(readTrustProxy({ TRUST_PROXY: '1' })).toBe(1);
    expect(readTrustProxy({ TRUST_PROXY: 'loopback,10.10.0.0/16' })).toEqual([
        'loopback',
        '10.10.0.0/16',
    ]);
    for (const value of [
        'true',
        '*',
        '0.0.0.0/0',
        '::/0',
        '-1',
        'bad-host',
        '10.0.0.0/99',
    ])
        expect(() => readTrustProxy({ TRUST_PROXY: value })).toThrow();
});
