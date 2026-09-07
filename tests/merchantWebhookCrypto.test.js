'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'webhook-crypto-test-secret-123456789';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'webhook-crypto-refresh-secret-123456789';

const { encrypt, decrypt } = require('../services/accountMfaService');

describe('merchant webhook signing-secret crypto', () => {
    test('exports a reversible encrypted storage primitive for webhook signing secrets', () => {
        const secret = 'merchant-webhook-signing-secret';
        const encrypted = encrypt(secret);

        expect(encrypted).not.toBe(secret);
        expect(decrypt(encrypted)).toBe(secret);
    });
});
