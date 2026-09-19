'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'device-trust-jwt-secret-key-must-be-32-chars';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'device-trust-refresh-secret-must-be-32-chars';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'device-trust-session-secret-must-be-32-chars';
process.env.PASSWORD_ONLY_LOGIN_MODE = 'false';
process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = 'true';
process.env.SECURITY_VERIFICATION_MODE = 'required';

jest.mock('../services/accountMfaService', () => ({
    loadAccount: jest.fn(),
    deviceIdFor: jest.fn(() => 'device-1'),
    isDeviceTrusted: jest.fn()
}));

jest.mock('../utils/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn()
}));

const accountMfaService = require('../services/accountMfaService');
const { deviceTrustMiddleware } = require('../src/Presentation/Middlewares/deviceTrustMiddleware');

describe('deviceTrustMiddleware', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        accountMfaService.loadAccount.mockResolvedValue({ _id: 'user-1' });
        accountMfaService.deviceIdFor.mockReturnValue('device-1');
    });

    test('fails closed on transfer paths when device trust lookup errors', async () => {
        accountMfaService.isDeviceTrusted.mockRejectedValue(new Error('store down'));
        const req = {
            originalUrl: '/api/mobile/client/new-transfer',
            user: { userId: 'user-1', accountType: 'client_user' }
        };
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
        const next = jest.fn();

        await deviceTrustMiddleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            code: 'DEVICE_TRUST_UNAVAILABLE'
        }));
        expect(req.isDeviceTrusted).toBe(false);
        expect(next).not.toHaveBeenCalled();
    });

    test('marks unknown users untrusted instead of leaving the flag undefined', async () => {
        const req = { originalUrl: '/api/mobile/profile', user: null };
        const res = {};
        const next = jest.fn();

        await deviceTrustMiddleware(req, res, next);

        expect(req.isDeviceTrusted).toBe(false);
        expect(next).toHaveBeenCalled();
    });
});
