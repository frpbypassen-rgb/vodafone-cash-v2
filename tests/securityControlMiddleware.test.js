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
    requestIp: jest.fn(() => '127.0.0.1')
}));

const securityControl = require('../services/securityControlService');
const Admin = require('../models/Admin');
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
});
