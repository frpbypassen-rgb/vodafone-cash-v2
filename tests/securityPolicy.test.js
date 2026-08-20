'use strict';

const {
    shouldBypassClientOtp,
    validateProductionSecurityEnv
} = require('../config/securityPolicy');

const productionEnv = (overrides = {}) => ({
    NODE_ENV: 'production',
    MONGO_URI: 'mongodb://127.0.0.1:27017/ahram',
    PUBLIC_APP_URL: 'https://ahrampay.com',
    JWT_SECRET: 'jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    JWT_REFRESH_SECRET: 'refresh-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    SESSION_SECRET: 'session-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    OTP_SECRET: 'otp-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    FORCE_CLIENT_OTP: 'true',
    BYPASS_OTP: 'false',
    BYPASS_CLIENT_OTP: 'false',
    DISABLE_OTP: 'false',
    SECURE_COOKIE: 'true',
    SESSION_STORE: 'mongo',
    MONGO_TRANSACTIONS_REQUIRED: 'true',
    TENANT_ISOLATION_REQUIRED: 'true',
    TENANT_MODE: 'single',
    DEFAULT_TENANT_SLUG: 'ahram',
    ALLOW_LEGACY_TENANTLESS_RECORDS: 'false',
    ALLOW_LEGACY_TENANT_TOKENS: 'false',
    REDIS_REQUIRED: 'false',
    ...overrides
});

describe('Production security policy', () => {
    test('accepts a hardened production configuration', () => {
        const result = validateProductionSecurityEnv(productionEnv());
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    test.each(['BYPASS_OTP', 'BYPASS_CLIENT_OTP', 'DISABLE_OTP'])(
        'rejects %s in production and never bypasses OTP',
        (flag) => {
            const env = productionEnv({ [flag]: 'true' });
            expect(shouldBypassClientOtp(env)).toBe(false);
            expect(validateProductionSecurityEnv(env).valid).toBe(false);
        }
    );

    test('rejects a fixed master OTP in production', () => {
        const result = validateProductionSecurityEnv(productionEnv({ MASTER_OTP: '123456' }));
        expect(result.valid).toBe(false);
        expect(result.errors.join(' ')).toContain('MASTER_OTP');
    });

    test('allows an explicit bypass only outside production', () => {
        expect(shouldBypassClientOtp({ NODE_ENV: 'development', BYPASS_CLIENT_OTP: 'true' })).toBe(true);
        expect(shouldBypassClientOtp({
            NODE_ENV: 'development',
            BYPASS_CLIENT_OTP: 'true',
            FORCE_CLIENT_OTP: 'true'
        })).toBe(false);
    });

    test('rejects reused secrets and insecure cookies', () => {
        const sharedSecret = 'shared-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
        const result = validateProductionSecurityEnv(productionEnv({
            JWT_SECRET: sharedSecret,
            OTP_SECRET: sharedSecret,
            SECURE_COOKIE: 'false'
        }));
        expect(result.valid).toBe(false);
        expect(result.errors.join(' ')).toContain('different secrets');
        expect(result.errors.join(' ')).toContain('SECURE_COOKIE');
    });

    test('rejects ambiguous or legacy tenant configuration in production', () => {
        const result = validateProductionSecurityEnv(productionEnv({
            DEFAULT_TENANT_SLUG: '',
            ALLOW_LEGACY_TENANTLESS_RECORDS: 'true',
            ALLOW_LEGACY_TENANT_TOKENS: 'true'
        }));
        expect(result.valid).toBe(false);
        expect(result.errors.join(' ')).toContain('DEFAULT_TENANT_ID');
        expect(result.errors.join(' ')).toContain('ALLOW_LEGACY_TENANTLESS_RECORDS');
        expect(result.errors.join(' ')).toContain('ALLOW_LEGACY_TENANT_TOKENS');
    });
});
