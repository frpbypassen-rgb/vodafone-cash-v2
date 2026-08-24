'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-for-security-control-tests-123456';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'jwt-secret-for-security-control-tests-123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'jwt-refresh-secret-for-security-tests-123456';

const securityControl = require('../services/securityControlService');
const { protectedMutation } = require('../middlewares/securityControl');
const passkeyService = require('../services/passkeyService');

describe('securityControlService', () => {
    test('uses an explicit mobile device identifier without setting a cookie', () => {
        const req = { headers: { 'x-device-id': 'mobile-device-123' } };
        expect(securityControl.ensureDeviceId(req, null)).toBe('mobile-device-123');
    });

    test('keeps web and app requests in separate security channels', () => {
        expect(securityControl.requestChannel({ headers: {}, baseUrl: '/client', path: '/dashboard' })).toBe('web');
        expect(securityControl.requestChannel({ headers: { 'x-client-channel': 'app' }, originalUrl: '/api/mobile/login' })).toBe('app');
        expect(securityControl.requestChannel({ headers: {}, baseUrl: '/api/v1/mobile', path: '/login' })).toBe('app');
        expect(securityControl.requestChannel({ headers: { 'x-client-channel': 'app' }, originalUrl: '/login' })).toBe('web');
    });

    test('defines one active device per principal and channel', () => {
        const SecurityDevice = require('../models/SecurityDevice');
        const uniqueIndex = SecurityDevice.schema.indexes().find(([, options]) => options.name === 'uniq_active_security_device_per_channel');
        expect(uniqueIndex).toBeDefined();
        expect(uniqueIndex[0]).toMatchObject({ principalType: 1, principalId: 1, channel: 1, status: 1 });
        expect(uniqueIndex[1].unique).toBe(true);
    });

    test('hashes device identifiers deterministically and separately', () => {
        expect(securityControl.hashDeviceId('a')).toBe(securityControl.hashDeviceId('a'));
        expect(securityControl.hashDeviceId('a')).not.toBe(securityControl.hashDeviceId('b'));
        expect(securityControl.hashDeviceId('a')).toHaveLength(64);
    });

    test('accepts valid coordinates and rejects malformed coordinates', () => {
        expect(securityControl.parseLocation({ body: { latitude: '32.88', longitude: '13.18', locationAccuracy: '12' }, headers: {} }))
            .toMatchObject({ latitude: 32.88, longitude: 13.18, accuracy: 12 });
        expect(securityControl.parseLocation({ body: { latitude: '200', longitude: '13' }, headers: {} })).toBeNull();
        expect(securityControl.parseLocation({ body: {}, headers: {} })).toBeNull();
    });

    test('blocks only high-confidence anonymizer signals', () => {
        expect(securityControl.assessNetworkRisk({ headers: { 'x-vpn-detected': 'true' } }).highRisk).toBe(true);
        expect(securityControl.assessNetworkRisk({ headers: { 'user-agent': 'VPN Browser Name' } }).highRisk).toBe(false);
    });

    test.each([
        ['POST', '/transaction/abc/assign-executor', true],
        ['POST', '/api/mobile/client/balance-transfer', true],
        ['POST', '/executor-portal/api/complete-task/abc', true],
        ['POST', '/admin/security/lockdown/activate', false],
        ['POST', '/support/messages', false],
        ['GET', '/transaction/abc', false]
    ])('classifies protected mutation %s %s', (method, path, expected) => {
        expect(protectedMutation({ method, path })).toBe(expected);
    });

    test('derives production WebAuthn relying-party values from PUBLIC_APP_URL', () => {
        const previous = process.env.PUBLIC_APP_URL;
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.PUBLIC_APP_URL = 'https://ahrampay.com';
        process.env.NODE_ENV = 'production';
        expect(passkeyService.relyingParty({ protocol: 'http', get: () => 'localhost:3000' }))
            .toMatchObject({ rpID: process.env.WEBAUTHN_RP_ID || 'ahrampay.com', origin: process.env.WEBAUTHN_ORIGIN || 'https://ahrampay.com' });
        process.env.PUBLIC_APP_URL = previous;
        process.env.NODE_ENV = previousNodeEnv;
    });

    test('uses the request origin for local WebAuthn previews', () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';
        expect(passkeyService.relyingParty({ protocol: 'http', get: () => 'localhost:3018' }))
            .toMatchObject({ rpID: 'localhost', origin: 'http://localhost:3018' });
        process.env.NODE_ENV = previousNodeEnv;
    });
});
