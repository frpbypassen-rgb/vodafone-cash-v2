'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../services/securityControlService', () => ({
    isLockdownActive: jest.fn(),
    getState: jest.fn(),
    sessionPrincipal: jest.fn(() => null),
    assessNetworkRisk: jest.fn(() => ({ highRisk: false, signals: [] })),
    ensureDeviceId: jest.fn(() => 'device-id'),
    hashDeviceId: jest.fn(() => 'a'.repeat(64)),
    requestIp: jest.fn(() => '127.0.0.1'),
    requestChannel: jest.fn(() => 'web'),
    activateDevice: jest.fn(),
    sessionDeviceRecentlyVerified: jest.fn(() => false),
    markSessionDeviceVerified: jest.fn(),
    touchDeviceLastSeen: jest.fn().mockResolvedValue(false)
}));

const securityControl = require('../services/securityControlService');
const Admin = require('../models/Admin');
const SecurityDevice = require('../models/SecurityDevice');
const {
    enforceSecuritySession,
    enforceEmergencyLockdown,
    enforceAdminPermissions
} = require('../middlewares/securityControl');

describe('security control middleware', () => {
    const previousPasswordOnlyMode = process.env.PASSWORD_ONLY_LOGIN_MODE;
    const previousEnforcementEnabled = process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED;
    const previousVerificationMode = process.env.SECURITY_VERIFICATION_MODE;
    const previousPasskeyRequired = process.env.PASSKEY_REQUIRED;

    beforeEach(() => {
        process.env.PASSWORD_ONLY_LOGIN_MODE = 'false';
        process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = 'true';
        process.env.SECURITY_VERIFICATION_MODE = 'required';
        process.env.PASSKEY_REQUIRED = 'true';
        jest.clearAllMocks();
        securityControl.getState.mockResolvedValue({
            lockdownActive: true,
            lockdownEndsAt: new Date(Date.now() + 60 * 60 * 1000),
            adminPermissionEnforcementEnabled: true
        });
        securityControl.isLockdownActive.mockResolvedValue(true);
    });

    afterAll(() => {
        if (previousPasswordOnlyMode === undefined) delete process.env.PASSWORD_ONLY_LOGIN_MODE;
        else process.env.PASSWORD_ONLY_LOGIN_MODE = previousPasswordOnlyMode;
        if (previousEnforcementEnabled === undefined) delete process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED;
        else process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = previousEnforcementEnabled;
        if (previousVerificationMode === undefined) delete process.env.SECURITY_VERIFICATION_MODE;
        else process.env.SECURITY_VERIFICATION_MODE = previousVerificationMode;
        if (previousPasskeyRequired === undefined) delete process.env.PASSKEY_REQUIRED;
        else process.env.PASSKEY_REQUIRED = previousPasskeyRequired;
    });

    test('blocks protected financial mutations with HTTP 423 during lockdown', async () => {
        const app = express();
        app.use(express.json());
        app.use(enforceEmergencyLockdown);
        app.post('/transaction/123/assign-executor', (_req, res) => res.json({ success: true }));

        const response = await request(app)
            .post('/transaction/123/assign-executor')
            .set('Accept', 'application/json')
            .send({ executorId: 'executor-1' });

        expect(response.status).toBe(423);
        expect(response.body.code).toBe('SECURITY_LOCKDOWN_ACTIVE');
    });

    test('keeps the security center writable during lockdown', async () => {
        const app = express();
        app.use(express.json());
        app.use(enforceEmergencyLockdown);
        app.post('/admin/security/policy', (_req, res) => res.json({ success: true }));

        const response = await request(app).post('/admin/security/policy').send({});

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
    });

    test('denies an administrator without the required write permission', async () => {
        const app = express();
        app.use((req, _res, next) => {
            req.session = {
                isLoggedIn: true,
                adminRole: 'admin',
                adminPermissions: ['settings.read']
            };
            next();
        });
        app.use(enforceAdminPermissions);
        app.post('/settings/update', (_req, res) => res.json({ success: true }));

        const response = await request(app)
            .post('/settings/update')
            .set('Accept', 'application/json');

        expect(response.status).toBe(403);
        expect(response.body.code).toBe('ADMIN_PERMISSION_DENIED');
    });

    test('forces a newly initialized primary administrator into security enrollment', async () => {
        securityControl.sessionPrincipal.mockReturnValue({
            principalType: 'admin',
            principalId: '507f1f77bcf86cd799439011',
            principalName: 'Primary administrator'
        });
        securityControl.getState.mockResolvedValue({
            adminSessionHours: 12,
            accountSessionHours: 12,
            highConfidenceVpnBlockEnabled: true,
            adminDeviceEnforcementEnabled: false,
            accountDeviceEnforcementEnabled: true
        });
        const findById = jest.spyOn(Admin, 'findById').mockReturnValue({
            select: () => ({
                lean: async () => ({ status: 'active', sessionVersion: 0, mustEnrollSecurity: true })
            })
        });
        const req = {
            path: '/transactions',
            method: 'GET',
            headers: {},
            session: { adminSessionVersion: 0 }
        };
        const res = {
            redirect: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        const next = jest.fn();

        await enforceSecuritySession(req, res, next);

        expect(res.redirect).toHaveBeenCalledWith('/admin/security?enroll=1');
        expect(next).not.toHaveBeenCalled();
        findById.mockRestore();
    });

    test('does not force security enrollment while verification is optional', async () => {
        process.env.SECURITY_VERIFICATION_MODE = 'optional';
        securityControl.sessionPrincipal.mockReturnValue({
            principalType: 'admin',
            principalId: '507f1f77bcf86cd799439011',
            principalName: 'Primary administrator'
        });
        securityControl.getState.mockResolvedValue({
            adminSessionHours: 12,
            accountSessionHours: 12,
            highConfidenceVpnBlockEnabled: true,
            adminDeviceEnforcementEnabled: true
        });
        const findById = jest.spyOn(Admin, 'findById').mockReturnValue({
            select: () => ({
                lean: async () => ({ status: 'active', sessionVersion: 0, mustEnrollSecurity: true })
            })
        });
        const req = {
            path: '/transactions',
            method: 'GET',
            headers: { 'x-vpn-detected': 'true' },
            session: { adminSessionVersion: 0 }
        };
        const res = {
            redirect: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        const next = jest.fn();

        await enforceSecuritySession(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.redirect).not.toHaveBeenCalled();
        findById.mockRestore();
    });

    test('lets OTP verify complete even when a leftover client session is present', async () => {
        securityControl.sessionPrincipal.mockReturnValue({
            principalType: 'client_company',
            principalId: 'company-1',
            principalName: 'شركة'
        });
        const req = {
            path: '/client/verify',
            method: 'GET',
            headers: {},
            session: { isClientLoggedIn: true, clientId: 'company-1' }
        };
        const res = { redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        await enforceSecuritySession(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.redirect).not.toHaveBeenCalled();
    });

    test('restores the bound device from the session and allows the portal request', async () => {
        const boundId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        securityControl.sessionPrincipal.mockReturnValue({
            principalType: 'client_company',
            principalId: 'company-1',
            principalName: 'شركة'
        });
        securityControl.getState.mockResolvedValue({
            adminSessionHours: 12,
            accountSessionHours: 12,
            highConfidenceVpnBlockEnabled: false,
            adminDeviceEnforcementEnabled: true,
            accountDeviceEnforcementEnabled: true
        });
        securityControl.ensureDeviceId.mockImplementation((req) => req.session.securityDeviceId || 'other');
        securityControl.hashDeviceId.mockImplementation((id) => (
            id === boundId ? 'a'.repeat(64) : 'b'.repeat(64)
        ));
        const findOne = jest.spyOn(SecurityDevice, 'findOne').mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    deviceIdHash: 'a'.repeat(64),
                    credentialId: 'cred',
                    lastSeenAt: new Date(0)
                })
            })
        });
        const req = {
            path: '/client/dashboard',
            method: 'GET',
            headers: {},
            session: {
                isClientLoggedIn: true,
                clientId: 'company-1',
                securityDeviceId: boundId,
                securityExpiresAt: Date.now() + 60 * 60 * 1000
            }
        };
        const res = { redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(), cookie: jest.fn() };
        const next = jest.fn();

        await enforceSecuritySession(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.redirect).not.toHaveBeenCalled();
        expect(securityControl.touchDeviceLastSeen).toHaveBeenCalled();
        expect(securityControl.markSessionDeviceVerified).toHaveBeenCalled();
        expect(findOne).toHaveBeenCalledWith(expect.objectContaining({
            principalType: 'client_company',
            principalId: 'company-1',
            channel: 'web',
            status: 'active'
        }));
        findOne.mockRestore();
    });

    test('redirects a mismatched session to login with DEVICE_BINDING_MISMATCH', async () => {
        securityControl.sessionPrincipal.mockReturnValue({
            principalType: 'executor',
            principalId: 'exec-1',
            principalName: 'منفذ'
        });
        securityControl.getState.mockResolvedValue({
            adminSessionHours: 12,
            accountSessionHours: 12,
            highConfidenceVpnBlockEnabled: false,
            accountDeviceEnforcementEnabled: true
        });
        securityControl.ensureDeviceId.mockReturnValue('new-device');
        securityControl.hashDeviceId.mockReturnValue('b'.repeat(64));
        const destroy = jest.fn((cb) => cb());
        const findOne = jest.spyOn(SecurityDevice, 'findOne').mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    deviceIdHash: 'a'.repeat(64)
                })
            })
        });
        const req = {
            path: '/executor-portal/dashboard',
            method: 'GET',
            headers: {},
            session: {
                isExecutorLoggedIn: true,
                executorId: 'exec-1',
                securityExpiresAt: Date.now() + 60 * 60 * 1000,
                destroy
            }
        };
        const res = { redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        await enforceSecuritySession(req, res, next);

        expect(destroy).toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith('/login?security=DEVICE_BINDING_MISMATCH');
        expect(next).not.toHaveBeenCalled();
        expect(findOne).toHaveBeenCalledWith(expect.objectContaining({
            principalType: 'executor',
            principalId: 'exec-1',
            channel: 'web',
            status: 'active'
        }));
        findOne.mockRestore();
    });

    test('skips the SecurityDevice lookup when the session was verified recently', async () => {
        securityControl.sessionPrincipal.mockReturnValue({
            principalType: 'client_company',
            principalId: 'company-1',
            principalName: 'شركة'
        });
        securityControl.getState.mockResolvedValue({
            adminSessionHours: 12,
            accountSessionHours: 12,
            highConfidenceVpnBlockEnabled: false,
            adminDeviceEnforcementEnabled: true,
            accountDeviceEnforcementEnabled: true
        });
        securityControl.sessionDeviceRecentlyVerified.mockReturnValue(true);
        const findOne = jest.spyOn(SecurityDevice, 'findOne');
        const req = {
            path: '/client/dashboard',
            method: 'GET',
            headers: {},
            session: {
                isClientLoggedIn: true,
                clientId: 'company-1',
                securityDeviceHash: 'a'.repeat(64),
                securityHasPasskey: true,
                securityExpiresAt: Date.now() + 60 * 60 * 1000
            }
        };
        const res = { redirect: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        await enforceSecuritySession(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(findOne).not.toHaveBeenCalled();
        expect(securityControl.touchDeviceLastSeen).not.toHaveBeenCalled();
        findOne.mockRestore();
    });
});
