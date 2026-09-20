'use strict';

/**
 * Production login and runtime flags that must stay aligned with
 * `validateProductionSecurityEnv()`. PM2 `env_production` and
 * `scripts/repairProductionEnv.js` both consume this object so a
 * password-only kill switch cannot be reintroduced in one place.
 *
 * Host-specific values (MONGO_URI, REDIS_URL, secrets) stay in `.env`.
 * Time-limited emergency OTP / standalone-write overrides also stay in
 * `.env` only — PM2 must not pin them or it would block a documented
 * break-glass window.
 */
const PRODUCTION_SECURITY_FLAGS = Object.freeze({
    PASSWORD_ONLY_LOGIN_MODE: 'false',
    SECURITY_VERIFICATION_ENFORCEMENT_ENABLED: 'true',
    SECURITY_VERIFICATION_MODE: 'required',
    FORCE_CLIENT_OTP: 'true',
    PASSKEY_REQUIRED: 'false',
    BYPASS_OTP: 'false',
    BYPASS_CLIENT_OTP: 'false',
    DISABLE_OTP: 'false',
    ENABLE_ENV_ADMIN_LOGIN: 'false',
    SECURE_COOKIE: 'true',
    SESSION_STORE: 'mongo',
    MONGO_TRANSACTIONS_REQUIRED: 'true',
    TENANT_ISOLATION_REQUIRED: 'true',
    ALLOW_LEGACY_TENANTLESS_RECORDS: 'false',
    ALLOW_LEGACY_TENANT_TOKENS: 'false',
    ALLOW_PUBLIC_SYSTEM_MONITOR: 'false',
    ALLOW_LEGACY_SAME_ORIGIN_CSRF: 'false',
    REDIS_ENABLED: 'true',
    REDIS_REQUIRED: 'true'
});

module.exports = {
    PRODUCTION_SECURITY_FLAGS
};
