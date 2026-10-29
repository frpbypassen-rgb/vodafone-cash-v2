'use strict';
const proof = require('../utils/emailLoginMfaProof');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const account = {
    _id: 'owner',
    webPassword: 'hashed-password',
    mfaEnabled: true,
    mfaType: 'totp',
    mfaConfiguredAt: new Date(),
    sessionVersion: 1,
};
test('Authenticator proof is account-, type-, credential- and lifetime-bound', () => {
    const saved = proof.create(account, 'company');
    expect(proof.valid(saved, account, 'company')).toBe(true);
    expect(proof.valid(saved, account, 'user')).toBe(false);
    expect(proof.valid(saved, { ...account, _id: 'other' }, 'company')).toBe(false);
    expect(proof.valid(saved, { ...account, webPassword: 'changed' }, 'company')).toBe(false);
    expect(proof.valid(saved, { ...account, sessionVersion: 2 }, 'company')).toBe(false);
    expect(proof.valid(saved, { ...account, mfaConfiguredAt: null }, 'company')).toBe(false);
    expect(proof.valid({ ...saved, expiresAt: Date.now() - 1 }, account, 'company')).toBe(false);
    expect(JSON.stringify(saved)).not.toContain('hashed-password');
});
test('MFA completion chains email verification before establishing the session', () => {
    const auth = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
    const start = auth.indexOf('const completeAccountMfaChallenge');
    const end = auth.indexOf('// A deployment', start);
    expect(auth.slice(start, end)).toContain('return startClientOtp(req, res, account, pending.accountType)');
    const controller = fs.readFileSync(
        path.join(__dirname, '../controllers/clientAuthController.js'),
        'utf8'
    );
    expect(controller.indexOf("require('../utils/emailLoginMfaProof').valid")).toBeLessThan(
        controller.indexOf('const otpAccepted')
    );
    expect(auth).toContain('account.emailOtpVerifiedAt || isLoginOtpRequired()');
});
test.each(['email', 'telegram'])(
    'MFA proof and location survive real session regeneration before choosing %s OTP',
    async (channel) => {
        const auth = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
        const source = auth.slice(
            auth.indexOf('const startClientOtp ='),
            auth.indexOf('const continueVerifiedPortalLogin =')
        );
        const req = {
            body: {},
            session: {
                pendingEmailMfaProof: proof.create(account, 'company'),
                pendingSecurityLocation: { latitude: 32, longitude: 13 },
            },
        };
        req.session.regenerate = (callback) => {
            req.session = {};
            callback();
        };
        const start = vm.runInNewContext(source + '\nstartClientOtp;', {
            require: (name) => {
                if (name === '../utils/emailLoginMfaProof') return proof;
                if (name === '../services/businessLoginChoiceService')
                    return {
                        isBusiness: () => true,
                        start: async (request, actor, type, values) => {
                            await require('../utils/sessionSecurity').establishAuthenticatedSession(request, {
                                ...values,
                                tempClientId: actor._id,
                                tempAccountType: type,
                                businessOtpChallengeId: 'choice-test-id',
                            });
                        },
                    };
                throw new Error('Unexpected import');
            },
            securityControl: {
                ensureDeviceId: () => 'device',
                hashDeviceId: () => 'device-hash',
                parseLocation: () => null,
            },
            issueLoginOtp: async () => ({
                status: 'sent',
                portal: { sessionTempIdKey: 'tempClientId', verifyPath: '/client/verify' },
                otpChallengeId: 'otp-id',
                delivery: { channel },
            }),
            establishAuthenticatedSession: require('../utils/sessionSecurity').establishAuthenticatedSession,
            readLoginOtpAttempt: () => ({}),
            logAction: async () => {},
            saveAndRedirect: () => {},
            String,
        });
        await start(req, {}, { ...account, otpDeliveryChannel: channel }, 'company');
        expect(proof.valid(req.session.pendingEmailMfaProof, account, 'company')).toBe(true);
        expect(req.session.pendingSecurityLocation).toEqual({ latitude: 32, longitude: 13 });
        expect(req.session.businessOtpChallengeId).toBe('choice-test-id');
        expect(req.session.otpDeliveryChannel).toBeUndefined();
        expect(req.session.tempClientId).toBe(account._id);
        expect(req.session.isClientLoggedIn).not.toBe(true);
    }
);
