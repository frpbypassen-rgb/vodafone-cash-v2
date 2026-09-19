'use strict';

describe('encryption helpers', () => {
    const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    afterEach(() => {
        jest.resetModules();
        delete process.env.ENCRYPTION_KEY;
        delete process.env.JWT_SECRET;
        delete process.env.NODE_ENV;
    });

    test('encrypts and decrypts with ENCRYPTION_KEY', () => {
        process.env.NODE_ENV = 'test';
        process.env.ENCRYPTION_KEY = TEST_KEY;
        const encryption = require('../utils/encryption');
        const encrypted = encryption.encrypt('hello-world');
        expect(encrypted.split(':')).toHaveLength(3);
        expect(encryption.decrypt(encrypted)).toBe('hello-world');
        expect(encryption.isEncrypted(encrypted)).toBe(true);
    });

    test('does not derive from JWT_SECRET', () => {
        process.env.NODE_ENV = 'test';
        process.env.ENCRYPTION_KEY = TEST_KEY;
        process.env.JWT_SECRET = 'jwt-secret-should-not-be-used-as-encryption-key';
        const encryption = require('../utils/encryption');
        const encrypted = encryption.encrypt('payload');
        expect(encryption.decrypt(encrypted)).toBe('payload');
    });

    test('requires ENCRYPTION_KEY in production', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.ENCRYPTION_KEY;
        const encryption = require('../utils/encryption');
        expect(() => encryption.encrypt('x')).toThrow(/ENCRYPTION_KEY is required/);
    });

    test('allows an explicit local-development fallback', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.ENCRYPTION_KEY;
        const encryption = require('../utils/encryption');
        expect(encryption.decrypt(encryption.encrypt('local-only'))).toBe('local-only');
    });
});
