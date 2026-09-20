'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-for-security-control-tests-123456';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'jwt-secret-for-security-control-tests-123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'jwt-refresh-secret-for-security-tests-123456';

const securityControl = require('../services/securityControlService');
const { protectedMutation } = require('../middlewares/securityControl');
const passkeyService = require('../services/passkeyService');
const bcrypt = require('bcryptjs');
const SecurityState = require('../models/SecurityState');

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

    test('defines one active device per principal across all channels', () => {
        const SecurityDevice = require('../models/SecurityDevice');
        const uniqueIndex = SecurityDevice.schema.indexes().find(([, options]) => options.name === 'uniq_active_security_device_per_account');
        expect(uniqueIndex).toBeDefined();
        expect(uniqueIndex[0]).toMatchObject({ principalType: 1, principalId: 1, status: 1 });
        expect(uniqueIndex[1].unique).toBe(true);
        const lastSeen = SecurityDevice.schema.indexes().find(([, options]) => options.name === 'security_device_lastSeenAt');
        expect(lastSeen).toBeDefined();
        expect(lastSeen[0]).toMatchObject({ status: 1, lastSeenAt: -1 });
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
        expect(securityControl.parseLocation({ body: { latitude: '', longitude: '' }, headers: {} })).toBeNull();
        expect(securityControl.parseLocation({ body: {}, headers: {} })).toBeNull();
    });

    test('restores a verified pre-authentication location after an OTP redirect', () => {
        const location = securityControl.parseLocation({
            body: {},
            headers: {},
            session: {
                pendingSecurityLocation: { latitude: 32.8872, longitude: 13.1913, accuracy: 18 }
            }
        });
        expect(location).toMatchObject({ latitude: 32.8872, longitude: 13.1913, accuracy: 18 });
    });

    test('blocks only high-confidence anonymizer signals', () => {
        expect(securityControl.assessNetworkRisk({ headers: { 'x-vpn-detected': 'true' } }).highRisk).toBe(true);
        expect(securityControl.assessNetworkRisk({ headers: { 'user-agent': 'VPN Browser Name' } }).highRisk).toBe(false);
    });

    test('verifies the one-time administrator recovery enrollment code', async () => {
        const emergencyCodeHash = await bcrypt.hash('AHRAM-12345678-ABCDEF12', 4);
        const query = {
            select: jest.fn().mockReturnThis(),
            exec: jest.fn().mockResolvedValue({ emergencyCodeHash, lockdownActive: false })
        };
        const stateLookup = jest.spyOn(SecurityState, 'findOne').mockReturnValue(query);
        securityControl.invalidateStateCache();

        await expect(securityControl.verifyEmergencyCode('ahram-12345678-abcdef12')).resolves.toBe(true);
        await expect(securityControl.verifyEmergencyCode('AHRAM-WRONG-CODE')).resolves.toBe(false);

        stateLookup.mockRestore();
        securityControl.invalidateStateCache();
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

    test('does not block portal login while enhanced verification is optional', async () => {
        const previous = {
            enforcement: process.env.SECURITY_CONTROL_TEST_ENFORCEMENT,
            passwordOnly: process.env.PASSWORD_ONLY_LOGIN_MODE,
            enabled: process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED,
            mode: process.env.SECURITY_VERIFICATION_MODE
        };
        process.env.SECURITY_CONTROL_TEST_ENFORCEMENT = 'true';
        process.env.PASSWORD_ONLY_LOGIN_MODE = 'true';
        process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = 'false';
        process.env.SECURITY_VERIFICATION_MODE = 'optional';
        try {
            await expect(securityControl.authorizeLogin({
                req: { headers: {}, body: {}, session: {} },
                res: null,
                principal: { principalType: 'executor', principalId: 'exec-1', principalName: 'منفذ' }
            })).resolves.toMatchObject({ allowed: true, verificationMode: 'optional' });
        } finally {
            if (previous.enforcement === undefined) delete process.env.SECURITY_CONTROL_TEST_ENFORCEMENT;
            else process.env.SECURITY_CONTROL_TEST_ENFORCEMENT = previous.enforcement;
            if (previous.passwordOnly === undefined) delete process.env.PASSWORD_ONLY_LOGIN_MODE;
            else process.env.PASSWORD_ONLY_LOGIN_MODE = previous.passwordOnly;
            if (previous.enabled === undefined) delete process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED;
            else process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = previous.enabled;
            if (previous.mode === undefined) delete process.env.SECURITY_VERIFICATION_MODE;
            else process.env.SECURITY_VERIFICATION_MODE = previous.mode;
        }
    });

    describe('device binding enrollment and mismatch recovery', () => {
        const SecurityDevice = require('../models/SecurityDevice');
        const SecurityAccessRequest = require('../models/SecurityAccessRequest');
        const Notification = require('../models/Notification');
        const previousEnv = {};

        const enforcementState = {
            adminDeviceEnforcementEnabled: true,
            accountDeviceEnforcementEnabled: true,
            adminApprovalRequired: true,
            singleDeviceOnly: true,
            locationRequired: false,
            highConfidenceVpnBlockEnabled: false,
            lockdownActive: false,
            adminSessionHours: 12,
            accountSessionHours: 12
        };

        const enableEnforcement = () => {
            previousEnv.enforcement = process.env.SECURITY_CONTROL_TEST_ENFORCEMENT;
            previousEnv.passwordOnly = process.env.PASSWORD_ONLY_LOGIN_MODE;
            previousEnv.enabled = process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED;
            previousEnv.mode = process.env.SECURITY_VERIFICATION_MODE;
            previousEnv.otpBypass = process.env.EMERGENCY_CLIENT_OTP_BYPASS;
            previousEnv.deviceBypass = process.env.EMERGENCY_DEVICE_BINDING_BYPASS;
            process.env.SECURITY_CONTROL_TEST_ENFORCEMENT = 'true';
            process.env.PASSWORD_ONLY_LOGIN_MODE = 'false';
            process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = 'true';
            process.env.SECURITY_VERIFICATION_MODE = 'required';
        };

        const restoreEnv = () => {
            const assign = (key, envKey) => {
                if (previousEnv[key] === undefined) delete process.env[envKey];
                else process.env[envKey] = previousEnv[key];
            };
            assign('enforcement', 'SECURITY_CONTROL_TEST_ENFORCEMENT');
            assign('passwordOnly', 'PASSWORD_ONLY_LOGIN_MODE');
            assign('enabled', 'SECURITY_VERIFICATION_ENFORCEMENT_ENABLED');
            assign('mode', 'SECURITY_VERIFICATION_MODE');
            assign('otpBypass', 'EMERGENCY_CLIENT_OTP_BYPASS');
            assign('deviceBypass', 'EMERGENCY_DEVICE_BINDING_BYPASS');
        };

        const mockState = () => {
            const query = {
                select: jest.fn().mockReturnThis(),
                exec: jest.fn().mockResolvedValue(enforcementState)
            };
            jest.spyOn(SecurityState, 'findOne').mockReturnValue(query);
            return jest.spyOn(SecurityState, 'findOneAndUpdate').mockReturnValue(query);
        };

        beforeEach(() => {
            enableEnforcement();
            securityControl.invalidateStateCache();
        });

        afterEach(() => {
            jest.restoreAllMocks();
            securityControl.invalidateStateCache();
            restoreEnv();
        });

        test('restores a missing cookie from the authenticated session instead of minting a new device id', () => {
            const deviceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
            const req = {
                headers: {},
                session: { securityDeviceId: deviceId }
            };
            const res = { cookie: jest.fn() };
            expect(securityControl.ensureDeviceId(req, res)).toBe(deviceId);
            expect(res.cookie).toHaveBeenCalledWith(
                'ahrampay_security_device',
                deviceId,
                expect.objectContaining({ path: '/', httpOnly: true })
            );
        });

        test('enrolls the first device even when revoked device history exists', async () => {
            mockState();
            const deviceId = '11111111-2222-3333-4444-555555555555';
            jest.spyOn(SecurityDevice, 'findOne').mockReturnValue({
                select: jest.fn().mockResolvedValue(null)
            });
            const updateMany = jest.spyOn(SecurityDevice, 'updateMany').mockResolvedValue({});
            const create = jest.spyOn(SecurityDevice, 'create').mockResolvedValue({
                _id: 'dev-1',
                status: 'active'
            });
            jest.spyOn(SecurityAccessRequest, 'updateMany').mockResolvedValue({});

            const result = await securityControl.authorizeLogin({
                req: {
                    headers: { cookie: `ahrampay_security_device=${deviceId}`, 'user-agent': 'Chrome' },
                    body: {},
                    session: {}
                },
                res: { cookie: jest.fn() },
                principal: { principalType: 'client_company', principalId: 'company-1', principalName: 'شركة الأهرام' },
                accountClass: 'account',
                allowFirstDevice: true,
                verifiedLogin: true
            });

            expect(result).toMatchObject({ allowed: true, enrolled: true });
            expect(updateMany).toHaveBeenCalled();
            expect(create).toHaveBeenCalledWith(expect.objectContaining({
                principalType: 'client_company',
                principalId: 'company-1',
                approvedBy: 'first_verified_login',
                status: 'active'
            }));
        });

        test('rebinds the current browser after a verified login when the stored device hash mismatches', async () => {
            mockState();
            const deviceId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
            const stale = {
                _id: 'old-device',
                deviceIdHash: securityControl.hashDeviceId('stale-device-id-000000000000'),
                save: jest.fn()
            };
            jest.spyOn(SecurityDevice, 'findOne').mockReturnValue({
                select: jest.fn().mockResolvedValue(stale)
            });
            jest.spyOn(SecurityDevice, 'updateMany').mockResolvedValue({});
            const create = jest.spyOn(SecurityDevice, 'create').mockResolvedValue({
                _id: 'new-device',
                status: 'active'
            });
            jest.spyOn(SecurityAccessRequest, 'updateMany').mockResolvedValue({});
            const notify = jest.spyOn(Notification, 'create').mockResolvedValue({});

            const result = await securityControl.authorizeLogin({
                req: {
                    headers: { cookie: `ahrampay_security_device=${deviceId}`, 'user-agent': 'Chrome' },
                    body: {},
                    session: {}
                },
                res: { cookie: jest.fn() },
                principal: { principalType: 'executor', principalId: 'exec-9', principalName: 'منفذ' },
                accountClass: 'account',
                allowFirstDevice: true,
                verifiedLogin: true
            });

            expect(result).toMatchObject({ allowed: true, rebound: true });
            expect(create).toHaveBeenCalledWith(expect.objectContaining({
                approvedBy: 'verified_login_rebind',
                status: 'active'
            }));
            expect(notify).toHaveBeenCalledWith(expect.objectContaining({
                type: 'security_device_transfer',
                audience: 'admin'
            }));
        });

        test('does not mint a new device identifier when minting is disabled', () => {
            const req = { headers: {}, session: {} };
            const res = { cookie: jest.fn() };
            expect(securityControl.ensureDeviceId(req, res, { mint: false })).toBe('');
            expect(res.cookie).not.toHaveBeenCalled();
        });

        test('does not rewrite lastSeenAt when the same IP was seen recently', async () => {
            const updateOne = jest.spyOn(SecurityDevice, 'updateOne').mockResolvedValue({});
            const device = { _id: 'dev-1', lastSeenAt: new Date(), lastIp: '10.0.0.8' };
            await expect(securityControl.touchDeviceLastSeen(device, { ip: '10.0.0.8' })).resolves.toBe(false);
            expect(updateOne).not.toHaveBeenCalled();
        });

        test('writes lastSeenAt when the device has never been seen', async () => {
            const updateOne = jest.spyOn(SecurityDevice, 'updateOne').mockResolvedValue({});
            const device = { _id: 'dev-1', lastSeenAt: null, lastIp: '' };
            await expect(securityControl.touchDeviceLastSeen(device, { ip: '10.0.0.8' })).resolves.toBe(true);
            expect(updateOne).toHaveBeenCalledWith(
                { _id: 'dev-1' },
                { $set: expect.objectContaining({ lastSeenAt: expect.any(Date), lastIp: '10.0.0.8' }) }
            );
        });

        test('reads security state without a write and reuses the in-process cache', async () => {
            securityControl.invalidateStateCache();
            const findOne = jest.spyOn(SecurityState, 'findOne').mockReturnValue({
                select: jest.fn().mockReturnThis(),
                exec: jest.fn().mockResolvedValue({
                    key: 'global',
                    lockdownActive: false,
                    accountDeviceEnforcementEnabled: true
                })
            });
            const findOneAndUpdate = jest.spyOn(SecurityState, 'findOneAndUpdate');

            await securityControl.getState();
            await securityControl.getState();

            expect(findOne).toHaveBeenCalledTimes(1);
            expect(findOneAndUpdate).not.toHaveBeenCalled();
            securityControl.invalidateStateCache();
        });

        test('keeps unverified device transfers on the admin review path', async () => {
            mockState();
            const deviceId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
            jest.spyOn(SecurityDevice, 'findOne').mockReturnValue({
                select: jest.fn().mockResolvedValue({
                    _id: 'old-device',
                    deviceIdHash: securityControl.hashDeviceId('other-device'),
                    save: jest.fn()
                })
            });
            const createDevice = jest.spyOn(SecurityDevice, 'create');
            jest.spyOn(SecurityAccessRequest, 'findOne').mockReturnValue({
                select: jest.fn().mockResolvedValue(null)
            });
            jest.spyOn(SecurityAccessRequest, 'create').mockResolvedValue({
                requestCode: 'SEC-TEST12'
            });
            jest.spyOn(Notification, 'create').mockResolvedValue({});

            const result = await securityControl.authorizeLogin({
                req: {
                    headers: { cookie: `ahrampay_security_device=${deviceId}`, 'user-agent': 'Chrome' },
                    body: {},
                    session: {}
                },
                res: { cookie: jest.fn() },
                principal: { principalType: 'admin', principalId: 'admin-1', principalName: 'مدير' },
                accountClass: 'admin',
                allowFirstDevice: false,
                verifiedLogin: false
            });

            expect(result).toMatchObject({
                allowed: false,
                code: 'AUTHENTICATOR_REQUIRED_FOR_DEVICE_TRANSFER'
            });
            expect(createDevice).not.toHaveBeenCalled();
        });
    });
});
