'use strict';
jest.mock('../models/User', () => ({
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
}));
jest.mock('../models/ClientEmployee', () => ({
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
}));
jest.mock('../models/AgentEmployee', () => ({
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
}));
jest.mock('../utils/sessionSecurity', () => ({
    establishAuthenticatedSession: jest.fn(async (req, data) => {
        Object.assign(req.session, data);
    }),
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue() }));
jest.mock('../services/securityControlService', () => ({
    authorizeLogin: jest.fn().mockResolvedValue({ allowed: true }),
    applySessionSecurity: jest.fn().mockResolvedValue(),
}));
jest.mock('../services/businessPortalService', () => ({
    resolveClientPostLoginHref: jest.fn(() => '/test-dashboard'),
}));
const { postVerify } = require('../controllers/clientAuthController');
const { establishAuthenticatedSession } = require('../utils/sessionSecurity');
const security = require('../services/securityControlService');
const { hashOtp } = require('../utils/otp');
const mfa = require('../utils/emailLoginMfaProof');
const User = require('../models/User'),
    Company = require('../models/ClientEmployee'),
    Staff = require('../models/AgentEmployee');
beforeEach(() => jest.clearAllMocks());
test.each([
    ['user', User],
    ['company', Company],
    ['agent_staff', Staff],
])('no %s session before both Authenticator and email OTP succeed', async (type, Model) => {
    const account = {
        _id: 'account-1',
        name: 'اختبار',
        status: 'active',
        webPassword: 'hash',
        sessionVersion: 1,
        mfaEnabled: true,
        mfaType: 'totp',
        mfaConfiguredAt: new Date(),
        otpChallengeId: 'login-challenge',
        otpCode: hashOtp('123456'),
        otpExpires: new Date(Date.now() + 300000),
    };
    Model.findById.mockReturnValue({ lean: async () => account });
    Model.findOneAndUpdate.mockReturnValue({ lean: async () => account });
    const req = {
        body: { otp: '123456' },
        session: {
            tempClientId: account._id,
            tempAccountType: type,
            otpChallengeId: 'login-challenge',
            save: (callback) => callback(),
        },
    };
    const res = { redirect: jest.fn(), render: jest.fn() };
    await postVerify(req, res);
    expect(res.redirect).toHaveBeenCalledWith('/login');
    expect(establishAuthenticatedSession).not.toHaveBeenCalled();
    expect(security.authorizeLogin).not.toHaveBeenCalled();
    Object.assign(req.session, {
        tempClientId: account._id,
        tempAccountType: type,
        otpChallengeId: 'login-challenge',
        pendingEmailMfaProof: mfa.create(account, type),
    });
    await postVerify(req, res);
    expect(establishAuthenticatedSession).toHaveBeenCalledTimes(1);
    expect(security.authorizeLogin).toHaveBeenCalledWith(
        expect.objectContaining({ authenticatorVerified: true, verifiedLogin: true })
    );
    expect(req.session.isClientLoggedIn).toBe(true);
});
