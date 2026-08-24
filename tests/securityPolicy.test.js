'use strict';

const {
    getSecurityVerificationMode,
    isEmergencyStandaloneFinancialWritesActive,
    isPasskeyRequired,
    isPasswordOnlyLoginMode,
    isSecurityVerificationEnforcementEnabled,
    isSecurityVerificationRequired,
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
    PASSWORD_ONLY_LOGIN_MODE: 'false',
    SECURITY_VERIFICATION_ENFORCEMENT_ENABLED: 'true',
    SECURITY_VERIFICATION_MODE: 'required',
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
    test('uses optional verification by default and bypasses client OTP', () => {
        const env = productionEnv({
            PASSWORD_ONLY_LOGIN_MODE: 'true',
            SECURITY_VERIFICATION_ENFORCEMENT_ENABLED: 'false',
            SECURITY_VERIFICATION_MODE: '',
            FORCE_CLIENT_OTP: 'false'
        });
        expect(getSecurityVerificationMode(env)).toBe('optional');
        expect(isSecurityVerificationRequired(env)).toBe(false);
        expect(shouldBypassClientOtp(env)).toBe(true);
        expect(validateProductionSecurityEnv(env).valid).toBe(true);
    });

    test('the central kill switch keeps verification optional despite stale required settings', () => {
        const env = productionEnv({
            PASSWORD_ONLY_LOGIN_MODE: 'true',
            SECURITY_VERIFICATION_ENFORCEMENT_ENABLED: 'false',
            SECURITY_VERIFICATION_MODE: 'required',
            PASSKEY_REQUIRED: 'true',
            FORCE_CLIENT_OTP: 'true'
        });
        expect(isPasswordOnlyLoginMode(env)).toBe(true);
        expect(isSecurityVerificationEnforcementEnabled(env)).toBe(false);
        expect(isSecurityVerificationRequired(env)).toBe(false);
        expect(isPasskeyRequired(env)).toBe(false);
        expect(shouldBypassClientOtp(env)).toBe(true);
    });

    test('keeps passkey optional unless it is explicitly required', () => {
        expect(isPasskeyRequired(productionEnv({ PASSKEY_REQUIRED: 'false' }))).toBe(false);
        expect(isPasskeyRequired(productionEnv({ PASSKEY_REQUIRED: 'true' }))).toBe(true);
    });

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
            PASSWORD_ONLY_LOGIN_MODE: 'false',
            SECURITY_VERIFICATION_ENFORCEMENT_ENABLED: 'true',
            SECURITY_VERIFICATION_MODE: 'required',
            BYPASS_CLIENT_OTP: 'true',
            FORCE_CLIENT_OTP: 'true'
        })).toBe(false);
    });

    test('allows a time-limited audited emergency bypass in production', () => {
        const now = Date.parse('2026-08-20T20:00:00Z');
        const env = productionEnv({
            EMERGENCY_CLIENT_OTP_BYPASS: 'true',
            EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT: '2026-08-21T02:00:00Z',
            EMERGENCY_CLIENT_OTP_BYPASS_REASON: 'Provider outage'
        });

        expect(shouldBypassClientOtp(env, now)).toBe(true);
    });

    test('does not bypass OTP after the emergency window expires', () => {
        const env = productionEnv({
            EMERGENCY_CLIENT_OTP_BYPASS: 'true',
            EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT: '2026-08-20T21:00:00Z',
            EMERGENCY_CLIENT_OTP_BYPASS_REASON: 'Provider outage'
        });

        expect(shouldBypassClientOtp(env, Date.parse('2026-08-20T21:00:01Z'))).toBe(false);
    });

    test('allows guarded standalone financial writes only during the emergency window', () => {
        const env = productionEnv({
            EMERGENCY_STANDALONE_FINANCIAL_WRITES: 'true',
            EMERGENCY_STANDALONE_FINANCIAL_WRITES_EXPIRES_AT: '2026-08-21T02:00:00Z',
            EMERGENCY_STANDALONE_FINANCIAL_WRITES_REASON: 'Replica set incident'
        });

        expect(isEmergencyStandaloneFinancialWritesActive(env, Date.parse('2026-08-20T20:00:00Z'))).toBe(true);
        expect(isEmergencyStandaloneFinancialWritesActive(env, Date.parse('2026-08-21T02:00:01Z'))).toBe(false);
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
