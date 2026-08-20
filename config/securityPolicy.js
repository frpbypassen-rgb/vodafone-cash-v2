'use strict';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const clean = (value) => String(value || '').trim();
const isEnabled = (value) => TRUE_VALUES.has(clean(value).toLowerCase());
const isProductionEnvironment = (env = process.env) => clean(env.NODE_ENV).toLowerCase() === 'production';
const MAX_EMERGENCY_OTP_BYPASS_MS = 24 * 60 * 60 * 1000;

const getEmergencyClientOtpBypassState = (env = process.env, now = Date.now()) => {
    const enabled = isEnabled(env.EMERGENCY_CLIENT_OTP_BYPASS);
    const expiresAt = clean(env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT);
    const expiresAtMs = Date.parse(expiresAt);
    const validExpiry = Number.isFinite(expiresAtMs);
    return {
        enabled,
        expiresAt,
        expiresAtMs,
        validExpiry,
        active: enabled && validExpiry && expiresAtMs > now
    };
};

const shouldBypassClientOtp = (env = process.env, now = Date.now()) => {
    const emergencyBypass = getEmergencyClientOtpBypassState(env, now);
    if (isProductionEnvironment(env)) return emergencyBypass.active;
    if (isEnabled(env.FORCE_CLIENT_OTP) || isEnabled(env.FORCE_OTP)) return false;

    const explicitBypass = isEnabled(env.BYPASS_OTP) || isEnabled(env.BYPASS_CLIENT_OTP);
    const demoDatabase = clean(env.MONGO_URI).toLowerCase() === 'demo';
    return explicitBypass || demoDatabase;
};

const validateProductionSecurityEnv = (env = process.env) => {
    const errors = [];
    const warnings = [];

    if (!isProductionEnvironment(env)) {
        return { valid: true, errors, warnings };
    }

    const requiredSecrets = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_SECRET'];
    for (const name of requiredSecrets) {
        if (clean(env[name]).length < 32) {
            errors.push(`${name} must contain at least 32 characters in production.`);
        }
    }

    const populatedSecrets = requiredSecrets
        .map((name) => [name, clean(env[name])])
        .filter(([, value]) => value.length >= 32);
    for (let left = 0; left < populatedSecrets.length; left += 1) {
        for (let right = left + 1; right < populatedSecrets.length; right += 1) {
            if (populatedSecrets[left][1] === populatedSecrets[right][1]) {
                errors.push(`${populatedSecrets[left][0]} and ${populatedSecrets[right][0]} must use different secrets.`);
            }
        }
    }

    const forbiddenFlags = ['BYPASS_OTP', 'BYPASS_CLIENT_OTP', 'DISABLE_OTP'];
    for (const name of forbiddenFlags) {
        if (isEnabled(env[name])) errors.push(`${name} cannot be enabled in production.`);
    }

    if (clean(env.MASTER_OTP)) errors.push('MASTER_OTP is not supported in production. Remove it from the environment.');
    if (!isEnabled(env.FORCE_CLIENT_OTP) && !isEnabled(env.FORCE_OTP)) {
        errors.push('FORCE_CLIENT_OTP=true is required in production.');
    }
    const emergencyBypass = getEmergencyClientOtpBypassState(env);
    if (emergencyBypass.enabled) {
        if (!emergencyBypass.validExpiry) {
            errors.push('EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT must be a valid ISO timestamp.');
        } else if (emergencyBypass.expiresAtMs > Date.now() + MAX_EMERGENCY_OTP_BYPASS_MS) {
            errors.push('Emergency client OTP bypass cannot remain active for more than 24 hours.');
        } else if (emergencyBypass.active && !clean(env.EMERGENCY_CLIENT_OTP_BYPASS_REASON)) {
            errors.push('EMERGENCY_CLIENT_OTP_BYPASS_REASON is required while the emergency bypass is active.');
        } else if (emergencyBypass.active) {
            warnings.push(`Emergency client OTP bypass is active until ${emergencyBypass.expiresAt}.`);
        } else {
            warnings.push('Emergency client OTP bypass has expired and is inactive.');
        }
    }
    if (!isEnabled(env.SECURE_COOKIE)) errors.push('SECURE_COOKIE=true is required in production.');
    if (!isEnabled(env.MONGO_TRANSACTIONS_REQUIRED)) {
        errors.push('MONGO_TRANSACTIONS_REQUIRED=true is required in production.');
    }
    if (!isEnabled(env.TENANT_ISOLATION_REQUIRED)) {
        errors.push('TENANT_ISOLATION_REQUIRED=true is required in production.');
    }
    const tenantMode = clean(env.TENANT_MODE).toLowerCase();
    if (!['single', 'multi'].includes(tenantMode)) {
        errors.push('TENANT_MODE must be either single or multi in production.');
    }
    if (!clean(env.DEFAULT_TENANT_ID) && !clean(env.DEFAULT_TENANT_SLUG)) {
        errors.push('DEFAULT_TENANT_ID or DEFAULT_TENANT_SLUG is required in production.');
    }
    if (tenantMode === 'multi' && !clean(env.TENANT_ROOT_DOMAIN)) {
        errors.push('TENANT_ROOT_DOMAIN is required when TENANT_MODE=multi.');
    }
    if (isEnabled(env.ALLOW_LEGACY_TENANTLESS_RECORDS)) {
        errors.push('ALLOW_LEGACY_TENANTLESS_RECORDS cannot be enabled in production.');
    }
    if (isEnabled(env.ALLOW_LEGACY_TENANT_TOKENS)) {
        errors.push('ALLOW_LEGACY_TENANT_TOKENS cannot be enabled in production.');
    }
    if (clean(env.SESSION_STORE).toLowerCase() === 'memory') {
        errors.push('SESSION_STORE=memory is forbidden in production.');
    }
    if (isEnabled(env.ALLOW_PUBLIC_SYSTEM_MONITOR)) {
        errors.push('ALLOW_PUBLIC_SYSTEM_MONITOR cannot be enabled in production.');
    }

    const mongoUri = clean(env.MONGO_URI);
    if (!mongoUri || mongoUri.toLowerCase() === 'demo') {
        errors.push('MONGO_URI must reference a real database in production.');
    }

    const publicAppUrl = clean(env.PUBLIC_APP_URL);
    if (publicAppUrl && !publicAppUrl.toLowerCase().startsWith('https://')) {
        errors.push('PUBLIC_APP_URL must use HTTPS in production.');
    }

    if (!isEnabled(env.REDIS_REQUIRED)) {
        warnings.push('REDIS_REQUIRED is not enabled; distributed locks and rate limits are not guaranteed across multiple instances.');
    }

    return { valid: errors.length === 0, errors, warnings };
};

const assertProductionSecurityEnv = (env = process.env) => {
    const result = validateProductionSecurityEnv(env);
    for (const warning of result.warnings) console.warn(`[SECURITY WARNING] ${warning}`);
    if (!result.valid) {
        const details = result.errors.map((error) => `- ${error}`).join('\n');
        throw new Error(`Unsafe production configuration:\n${details}`);
    }
    return result;
};

module.exports = {
    assertProductionSecurityEnv,
    getEmergencyClientOtpBypassState,
    isEnabled,
    isProductionEnvironment,
    shouldBypassClientOtp,
    validateProductionSecurityEnv
};
