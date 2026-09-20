'use strict';

const ecosystem = require('../ecosystem.config');
const { PRODUCTION_SECURITY_FLAGS } = require('../config/productionSecurityDefaults');
const {
    isSecurityVerificationRequired,
    validateProductionSecurityEnv
} = require('../config/securityPolicy');

const productionSecrets = {
    MONGO_URI: 'mongodb://127.0.0.1:27017/ahram',
    PUBLIC_APP_URL: 'https://ahrampay.com',
    JWT_SECRET: 'jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    JWT_REFRESH_SECRET: 'refresh-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    SESSION_SECRET: 'session-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    OTP_SECRET: 'otp-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
    DEFAULT_TENANT_SLUG: 'ahram',
    REDIS_URL: 'redis://127.0.0.1:6379'
};

describe('PM2 environment isolation', () => {
    test('pins production and staging to separate ports and env files', () => {
        const core = ecosystem.apps.find((app) => app.name === 'Ahram_Core_API');
        const staging = ecosystem.apps.find((app) => app.name === 'Ahram_Staging_API');

        expect(core.env_production).toMatchObject({
            NODE_ENV: 'production',
            PORT: '3000',
            DOTENV_CONFIG_PATH: '.env'
        });
        expect(staging.env_staging).toMatchObject({
            NODE_ENV: 'staging',
            PORT: '3100',
            DOTENV_CONFIG_PATH: '.env.staging'
        });
    });

    test('production PM2 env uses the shared security flags and can boot the policy', () => {
        const core = ecosystem.apps.find((app) => app.name === 'Ahram_Core_API');

        expect(core.env_production).toMatchObject(PRODUCTION_SECURITY_FLAGS);
        expect(core.env_production.PASSWORD_ONLY_LOGIN_MODE).toBe('false');
        expect(core.env_production.EMERGENCY_CLIENT_OTP_BYPASS).toBeUndefined();
        expect(core.env_production.EMERGENCY_STANDALONE_FINANCIAL_WRITES).toBeUndefined();

        const merged = { ...productionSecrets, ...core.env_production };
        const result = validateProductionSecurityEnv(merged);
        expect(isSecurityVerificationRequired(merged)).toBe(true);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });
});
