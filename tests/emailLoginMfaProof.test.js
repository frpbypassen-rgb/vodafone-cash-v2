'use strict';
const proof = require('../utils/emailLoginMfaProof');
const fs = require('node:fs');
const path = require('node:path');
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
