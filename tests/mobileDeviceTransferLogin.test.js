'use strict';

jest.mock('../repositories/userRepository', () => ({ findByCredentials: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));

process.env.JWT_SECRET ||= 'test-jwt-secret-that-is-longer-than-thirty-two-characters';
process.env.JWT_REFRESH_SECRET ||= 'different-refresh-secret-that-is-longer-than-thirty-two';

const auth = require('../services/authService');
const userRepo = require('../repositories/userRepository');
const mfa = require('../services/accountMfaService');
const security = require('../services/securityControlService');

const account = { _id: 'executor-1', name: 'Test executor' };
const req = {
    originalUrl: '/api/mobile/login',
    headers: { 'x-device-id': 'new-test-phone' },
    body: {}
};
const previousEnforcement = process.env.SECURITY_CONTROL_TEST_ENFORCEMENT;

beforeEach(() => {
    process.env.SECURITY_CONTROL_TEST_ENFORCEMENT = 'true';
    userRepo.findByCredentials.mockResolvedValue({ account, accountType: 'executor' });
    jest.spyOn(security, 'getState').mockResolvedValue({ mandatoryAuthenticatorEnabled: false });
});

afterEach(() => {
    jest.restoreAllMocks();
    if (previousEnforcement === undefined) delete process.env.SECURITY_CONTROL_TEST_ENFORCEMENT;
    else process.env.SECURITY_CONTROL_TEST_ENFORCEMENT = previousEnforcement;
});

test('returns an Authenticator challenge for a phone transfer even if enrollment is optional', async () => {
    jest.spyOn(mfa, 'loadAccount').mockResolvedValue({
        ...account, mfaEnabled: true, mfaType: 'totp', totpSecretEncrypted: 'configured'
    });
    jest.spyOn(security, 'authorizeLogin').mockResolvedValue({
        allowed: false, code: 'AUTHENTICATOR_REQUIRED_FOR_DEVICE_TRANSFER'
    });

    const result = await auth.login('test-account', 'fixture-password', req);

    expect(result).toMatchObject({ success: false, code: 'MFA_REQUIRED', mfaChallengeToken: expect.any(String) });
    expect(result).not.toHaveProperty('accessToken');
});

test('requests platform approval when the account is marked enrolled but has no secret', async () => {
    jest.spyOn(mfa, 'loadAccount').mockResolvedValue({ ...account, mfaEnabled: true, mfaType: 'totp' });
    const authorize = jest.spyOn(security, 'authorizeLogin').mockResolvedValue({
        allowed: false, code: 'DEVICE_APPROVAL_REQUIRED', requestCode: 'SEC-FIXTURE'
    });

    const result = await auth.login('test-account', 'fixture-password', req);

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
        allowUnenrolledAppTransferRequest: true, requireAdminDeviceApproval: true
    }));
    expect(result).toMatchObject({ success: false, code: 'DEVICE_APPROVAL_REQUIRED', requestCode: 'SEC-FIXTURE' });
    expect(result).not.toHaveProperty('mfaEnrollmentToken');
});
