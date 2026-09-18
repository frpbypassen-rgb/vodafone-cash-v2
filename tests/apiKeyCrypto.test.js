'use strict';

const { generateApiKey, hashApiKey, apiKeyHint } = require('../utils/apiKeyCrypto');

describe('apiKeyCrypto', () => {
    const previousPepper = process.env.API_KEY_PEPPER;

    beforeEach(() => {
        process.env.API_KEY_PEPPER = 'unit-test-api-key-pepper-must-be-32-chars';
    });

    afterAll(() => {
        if (previousPepper === undefined) delete process.env.API_KEY_PEPPER;
        else process.env.API_KEY_PEPPER = previousPepper;
    });

    test('hashes keys with a dedicated pepper and never stores the plaintext', () => {
        const key = generateApiKey();
        expect(key.startsWith('ak_live_')).toBe(true);
        expect(hashApiKey(key)).toMatch(/^[a-f0-9]{64}$/);
        expect(hashApiKey(key)).toBe(hashApiKey(key));
        expect(hashApiKey(key)).not.toBe(key);
        expect(apiKeyHint(key)).toBe(key.slice(-4));
    });

    test('requires API_KEY_PEPPER in production', () => {
        const previousEnv = process.env.NODE_ENV;
        const previousPepper = process.env.API_KEY_PEPPER;
        try {
            process.env.NODE_ENV = 'production';
            delete process.env.API_KEY_PEPPER;
            jest.resetModules();
            const { hashApiKey } = require('../utils/apiKeyCrypto');
            expect(() => hashApiKey('ak_live_test')).toThrow(/API_KEY_PEPPER/);
        } finally {
            process.env.NODE_ENV = previousEnv;
            if (previousPepper === undefined) delete process.env.API_KEY_PEPPER;
            else process.env.API_KEY_PEPPER = previousPepper;
            jest.resetModules();
        }
    });
});
