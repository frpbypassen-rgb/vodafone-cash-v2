'use strict';

const { PRODUCTION_SECURITY_FLAGS } = require('../config/productionSecurityDefaults');
const {
    isPasswordOnlyLoginMode,
    isSecurityVerificationRequired,
    validateProductionSecurityEnv
} = require('../config/securityPolicy');

describe('production security defaults', () => {
    test('never encode the password-only production kill switch', () => {
        expect(PRODUCTION_SECURITY_FLAGS.PASSWORD_ONLY_LOGIN_MODE).toBe('false');
        expect(PRODUCTION_SECURITY_FLAGS.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED).toBe('true');
        expect(PRODUCTION_SECURITY_FLAGS.SECURITY_VERIFICATION_MODE).toBe('required');
        expect(PRODUCTION_SECURITY_FLAGS.FORCE_CLIENT_OTP).toBe('true');
        expect(PRODUCTION_SECURITY_FLAGS.REDIS_REQUIRED).toBe('true');
        expect(PRODUCTION_SECURITY_FLAGS.REDIS_ENABLED).toBe('true');
    });

    test('satisfy assertProductionSecurityEnv when merged with host secrets', () => {
        const env = {
            NODE_ENV: 'production',
            MONGO_URI: 'mongodb://127.0.0.1:27017/ahram',
            PUBLIC_APP_URL: 'https://ahrampay.com',
            JWT_SECRET: 'jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
            JWT_REFRESH_SECRET: 'refresh-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
            SESSION_SECRET: 'session-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
            OTP_SECRET: 'otp-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
            DEFAULT_TENANT_SLUG: 'ahram',
            TENANT_MODE: 'single',
            REDIS_URL: 'redis://127.0.0.1:6379',
            ...PRODUCTION_SECURITY_FLAGS
        };

        expect(isPasswordOnlyLoginMode(env)).toBe(false);
        expect(isSecurityVerificationRequired(env)).toBe(true);
        expect(validateProductionSecurityEnv(env).valid).toBe(true);
        expect(validateProductionSecurityEnv(env).errors).toEqual([]);
    });
});
