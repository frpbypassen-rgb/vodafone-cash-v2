'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-that-is-longer-than-thirty-two-characters';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'different-refresh-secret-that-is-longer-than-thirty-two';
process.env.MFA_ENCRYPTION_KEY = '4f8a9d93f1a7cc4b6e0989143675f3642c212478be38b2f00cd141f95c305db2';

const accountMfaService = require('../services/accountMfaService');

describe('accountMfaService', () => {
    let nowSpy;

    beforeEach(() => {
        // RFC 6238 test timestamp. With 6 digits, the expected SHA1 token is 287082.
        nowSpy = jest.spyOn(Date, 'now').mockReturnValue(59000);
    });

    afterEach(() => {
        nowSpy.mockRestore();
    });

    test('verifies a standards-compatible six digit TOTP', () => {
        expect(accountMfaService.verifyTotp(
            'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
            '287082',
            0
        )).toBe(true);
        expect(accountMfaService.verifyTotp(
            'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
            '000000',
            0
        )).toBe(false);
    });

    test('confirms setup with encrypted secret and hashed recovery codes', async () => {
        const account = {
            _id: '507f1f77bcf86cd799439011',
            webUsername: 'user@ahram.com',
            mfaEnabled: false,
            mfaType: 'none',
            save: jest.fn().mockResolvedValue(undefined)
        };
        const codes = ['ABCDE-12345', 'FGHIJ-67890'];

        await accountMfaService.confirmSetup(
            account,
            'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
            '287082',
            codes
        );

        expect(account.mfaEnabled).toBe(true);
        expect(account.mfaType).toBe('totp');
        expect(account.totpSecretEncrypted).not.toContain('GEZDGNBV');
        expect(account.mfaRecoveryCodeHashes).toHaveLength(2);
        expect(account.mfaRecoveryCodeHashes).not.toContain(codes[0]);
        expect(await accountMfaService.verifyAccountToken(account, '287082')).toBe(true);
    });

    test('creates an Authenticator URI without exposing internal account data', () => {
        const result = accountMfaService.setup({
            _id: '507f1f77bcf86cd799439011',
            webUsername: 'secure.user@ahram.com'
        });

        expect(result.secret).toMatch(/^[A-Z2-7]{20}$/);
        expect(result.qrUri).toContain('otpauth://totp/');
        expect(result.qrUri).toContain('secure.user%40ahram.com');
        expect(result.recoveryCodes).toHaveLength(8);
        expect(result.recoveryCodeHashes).toHaveLength(8);
    });

    test.each([
        ['user', 'client_user'],
        ['agent', 'client_user'],
        ['company', 'client_company'],
        ['sub_client', 'sub_client'],
        ['agent_staff', 'agent_staff'],
        ['executor', 'executor']
    ])('normalizes %s to the protected account type %s', (input, expected) => {
        expect(accountMfaService.normalizeAccountType(input)).toBe(expected);
    });

    test('maps all login model names to canonical protected account types', () => {
        expect(accountMfaService.accountTypeForModel({ $modelName: 'User' })).toBe('client_user');
        expect(accountMfaService.accountTypeForModel({ $modelName: 'ClientEmployee' })).toBe('client_company');
        expect(accountMfaService.accountTypeForModel({ $modelName: 'AgentEmployee' })).toBe('agent_staff');
        expect(accountMfaService.accountTypeForModel({ $modelName: 'Employee' })).toBe('executor');
    });
});
