'use strict';

// Production-like environment for the RC review. The four kill switches stay
// unset, which outside staging means enabled. APP_ENV and ENVIRONMENT stay
// unset so the process is not treated as staging.

const SWITCHES = [
    'EXTERNAL_API_ENABLED',
    'BULLMQ_WORKERS_ENABLED',
    'FINANCIAL_SCHEDULERS_ENABLED',
    'MERCHANT_WEBHOOK_WORKER_ENABLED'
];

const applyProductionEnv = () => {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_ENV;
    delete process.env.ENVIRONMENT;
    delete process.env.DOTENV_CONFIG_PATH;
    SWITCHES.forEach((name) => {
        delete process.env[name];
    });

    process.env.JWT_SECRET = 'rc-review-jwt-secret-2026-not-production-use';
    process.env.JWT_REFRESH_SECRET = 'rc-review-jwt-refresh-secret-2026-not-prod';
    process.env.SESSION_SECRET = 'rc-review-session-secret-2026-not-prod-xx';
    process.env.OTP_SECRET = 'rc-review-otp-secret-2026-not-production-x';
    process.env.SECURE_COOKIE = 'true';
    process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';
    process.env.TENANT_ISOLATION_REQUIRED = 'true';
    process.env.TENANT_MODE = 'single';
    process.env.DEFAULT_TENANT_SLUG = 'ahram-rc-review';
    process.env.PASSWORD_ONLY_LOGIN_MODE = 'false';
    process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = 'true';
    process.env.SECURITY_VERIFICATION_MODE = 'required';
    process.env.FORCE_CLIENT_OTP = 'true';
    process.env.BYPASS_OTP = 'false';
    process.env.BYPASS_CLIENT_OTP = 'false';
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_REQUIRED = 'true';
    process.env.API_COMPLETION_DELAY_MS = '0';
    process.env.PUBLIC_APP_URL = 'http://127.0.0.1:3998';

    if (process.env.RC_REDIS_URL) process.env.REDIS_URL = process.env.RC_REDIS_URL;
    if (process.env.RC_MONGO_URI) process.env.MONGO_URI = process.env.RC_MONGO_URI;
};

module.exports = { SWITCHES, applyProductionEnv };
