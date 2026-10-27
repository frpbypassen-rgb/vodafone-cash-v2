'use strict';
process.env.JWT_SECRET = 'web-mfa-test-secret-at-least-thirty-two-characters';
process.env.JWT_REFRESH_SECRET = 'web-mfa-test-refresh-at-least-thirty-two-characters';
process.env.MFA_ENCRYPTION_KEY = '4f8a9d93f1a7cc4b6e0989143675f3642c212478be38b2f00cd141f95c305db2';
const mfa = require('../services/accountMfaService');
const enrollment = require('../services/webMfaEnrollmentService');
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const codes = ['ABCDE-12345', 'FGHIJ-67890'];
let session, account, clock;
beforeEach(() => {
    session = {};
    account = {
        _id: '507f1f77bcf86cd799439011',
        webUsername: 'owner@example.test',
        mfaEnabled: false,
        save: jest.fn(async () => {}),
    };
    clock = jest.spyOn(Date, 'now').mockReturnValue(59000);
    jest.spyOn(mfa, 'setup').mockReturnValue({
        secret,
        qrUri: `otpauth://totp/Demo:owner?secret=${secret}&issuer=Demo`,
        recoveryCodes: codes,
    });
});
afterEach(() => jest.restoreAllMocks());
test('setup is encrypted, produces a local QR image, and resumes without changing the account', async () => {
    const first = await enrollment.start(session, account, 'company');
    expect(first.secret).toBe(secret);
    expect(first.qrImage).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(first.qrImage.split(',')[1], 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(JSON.stringify(session)).not.toContain(secret);
    expect(JSON.stringify(session)).not.toContain(codes[0]);
    const restored = await enrollment.resume(session, account, 'company');
    expect(restored.stage).toBe('setup');
    expect(restored.setup.secret).toBe(secret);
    expect((await enrollment.start(session, account, 'company')).secret).toBe(secret);
    expect(mfa.setup).toHaveBeenCalledTimes(1);
    expect(account.save).not.toHaveBeenCalled();
});
test('a wrong verification code keeps protection disabled and keeps the setup available', async () => {
    await enrollment.start(session, account, 'company');
    await expect(enrollment.confirm(session, account, 'company', '000000')).rejects.toMatchObject({
        code: 'MFA_INVALID',
    });
    expect(account.mfaEnabled).toBe(false);
    expect((await enrollment.resume(session, account, 'company')).stage).toBe('setup');
});
test('confirmation uses the server-bound secret and exposes recovery codes until acknowledgment', async () => {
    await enrollment.start(session, account, 'company');
    await enrollment.confirm(session, account, 'company', '287082');
    expect(account.mfaEnabled).toBe(true);
    expect(account.totpSecretEncrypted).not.toContain(secret);
    expect(account.mfaRecoveryCodeHashes).toHaveLength(2);
    const restored = await enrollment.resume(session, account, 'company');
    expect(restored).toMatchObject({ stage: 'recovery', recoveryCodes: codes });
    expect(restored).not.toHaveProperty('setup');
    await enrollment.acknowledge(session, account, 'company');
    expect(await enrollment.resume(session, account, 'company')).toBeNull();
    expect(account.mfaEnabled).toBe(true);
});
test('expired setup cannot activate protection', async () => {
    await enrollment.start(session, account, 'company');
    clock.mockReturnValue(59000 + 11 * 60000);
    await expect(enrollment.confirm(session, account, 'company', '287082')).rejects.toMatchObject({
        code: 'MFA_SETUP_EXPIRED',
    });
    expect(await enrollment.resume(session, account, 'company')).toBeNull();
    expect(account.save).not.toHaveBeenCalled();
});
test('recovery display expires without disabling the account or removing its saved hashes', async () => {
    await enrollment.start(session, account, 'company');
    await enrollment.confirm(session, account, 'company', '287082');
    clock.mockReturnValue(59000 + 16 * 60000);
    expect(await enrollment.resume(session, account, 'company')).toBeNull();
    expect(account.mfaEnabled).toBe(true);
    expect(account.mfaRecoveryCodeHashes).toHaveLength(2);
});
test('a recovery snapshot cannot be shown after the account factor is replaced elsewhere', async () => {
    await enrollment.start(session, account, 'company');
    await enrollment.confirm(session, account, 'company', '287082');
    await mfa.confirmSetup(account, secret, '287082', ['ZZZZZ-98765']);
    expect(await enrollment.resume(session, account, 'company')).toBeNull();
    expect(account.mfaEnabled).toBe(true);
    expect(account.mfaRecoveryCodeHashes).toHaveLength(1);
});
test('another account or account type cannot read or confirm the setup', async () => {
    await enrollment.start(session, account, 'company');
    const other = { ...account, _id: '507f1f77bcf86cd799439012' };
    expect(await enrollment.resume({ ...session }, other, 'company')).toBeNull();
    await expect(enrollment.confirm({ ...session }, account, 'agent_staff', '287082')).rejects.toMatchObject({
        code: 'MFA_SETUP_EXPIRED',
    });
    expect(account.save).not.toHaveBeenCalled();
});
test('cancel removes pending setup and an active factor cannot be silently replaced', async () => {
    await enrollment.start(session, account, 'company');
    enrollment.cancel(session, account, 'company');
    await expect(enrollment.confirm(session, account, 'company', '287082')).rejects.toMatchObject({
        code: 'MFA_SETUP_EXPIRED',
    });
    account.mfaEnabled = true;
    account.mfaType = 'totp';
    account.totpSecretEncrypted = 'present';
    await expect(enrollment.start(session, account, 'company')).rejects.toMatchObject({
        code: 'MFA_ALREADY_ENABLED',
    });
});
