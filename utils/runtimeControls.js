'use strict';

// Background subsystems stay off unless the operator sets an explicit truthy
// value (1/true/yes/on), matching utils/passwordResetAvailability.js.
// Unset, empty, false, 0, and any other value are off.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const STAGING_KEYS = ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT'];
const PROVIDER_URL_ENV_KEYS = ['ZAYN_AGGREGATOR_URL', 'ZAYNPAY_URL', 'ZAYN_EXECUTOR_API_URL'];
const PM2_ENV_KEYS = ['name', 'PM2_NAME', 'PM2_APP_NAME'];
const PRODUCTION_PM2_NAME = 'ahram_core_api';

const isExplicitlyEnabled = (value) => TRUTHY.has(String(value ?? '').trim().toLowerCase());

const isMerchantWebhookWorkerEnabled = (env = process.env) => (
    isExplicitlyEnabled(env.MERCHANT_WEBHOOK_WORKER_ENABLED)
);

const isExternalApiEnabled = (env = process.env) => isExplicitlyEnabled(env.EXTERNAL_API_ENABLED);

const isBullmqWorkersEnabled = (env = process.env) => isExplicitlyEnabled(env.BULLMQ_WORKERS_ENABLED);

const isFinancialSchedulersEnabled = (env = process.env) => (
    isExplicitlyEnabled(env.FINANCIAL_SCHEDULERS_ENABLED)
);

const disabledSubsystemFlags = (env = process.env) => {
    const disabled = [];
    if (!isMerchantWebhookWorkerEnabled(env)) disabled.push('MERCHANT_WEBHOOK_WORKER_ENABLED');
    if (!isExternalApiEnabled(env)) disabled.push('EXTERNAL_API_ENABLED');
    if (!isBullmqWorkersEnabled(env)) disabled.push('BULLMQ_WORKERS_ENABLED');
    if (!isFinancialSchedulersEnabled(env)) disabled.push('FINANCIAL_SCHEDULERS_ENABLED');
    return disabled;
};

const logDisabledRuntimeSubsystems = (logger, env = process.env) => {
    const disabled = disabledSubsystemFlags(env);
    if (!disabled.length || !logger || typeof logger.warn !== 'function') return disabled;
    logger.warn(
        `Startup subsystem switches are OFF: ${disabled.join(', ')}. `
        + 'Unset means off. Production must set MERCHANT_WEBHOOK_WORKER_ENABLED, '
        + 'EXTERNAL_API_ENABLED, BULLMQ_WORKERS_ENABLED, and FINANCIAL_SCHEDULERS_ENABLED '
        + 'to true or webhooks, provider calls, queues, and financial schedulers will not run.'
    );
    return disabled;
};

const isStagingRuntime = (env = process.env) => STAGING_KEYS.some(
    (key) => String(env[key] || '').trim().toLowerCase() === 'staging'
);

const normalizeHost = (value) => String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');

const isLoopbackHost = (value) => LOOPBACK_HOSTS.has(normalizeHost(value));

const hostnameOf = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (isLoopbackHost(raw)) return normalizeHost(raw);
    try {
        const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
        return normalizeHost(new URL(withScheme).hostname);
    } catch (_error) {
        return normalizeHost(raw.split('/')[0].replace(/:\d+$/, ''));
    }
};

const sandboxHostAllowlist = (env = process.env) => {
    const extra = String(env.STAGING_SANDBOX_HOST_ALLOWLIST || '')
        .split(/[,;\s]+/)
        .map((item) => normalizeHost(item))
        .filter(Boolean);
    return new Set([...LOOPBACK_HOSTS, ...extra]);
};

const isSandboxProviderUrl = (value, env = process.env) => {
    const host = hostnameOf(value);
    if (!host) return false;
    return sandboxHostAllowlist(env).has(host);
};

// Production keeps preset.apiUrl (https://zaynpay.com) when no explicit URL is
// configured. Staging never uses that fallback: an unset or non-sandbox URL
// is refused before any outbound call.
const resolveProviderBaseUrl = ({ explicitUrl = '', presetUrl = '', env = process.env } = {}) => {
    const explicit = String(explicitUrl || '').trim();
    if (isStagingRuntime(env)) {
        if (!explicit) return { baseUrl: '', refused: true, reason: 'PROVIDER_URL_UNSET' };
        if (!isSandboxProviderUrl(explicit, env)) {
            return { baseUrl: '', refused: true, reason: 'PROVIDER_URL_NOT_SANDBOX' };
        }
        return { baseUrl: explicit.replace(/\/+$/, ''), refused: false, reason: '' };
    }
    const chosen = explicit || String(presetUrl || '').trim();
    return { baseUrl: chosen.replace(/\/+$/, ''), refused: false, reason: '' };
};

const collectStagingEnvViolations = (env = process.env) => {
    const violations = [];
    const port = String(env.PORT == null ? '' : env.PORT).trim();
    if (!port || port === '3000') {
        violations.push({ code: 'PORT_PRODUCTION', name: 'listen-port', detail: '3000 or unset' });
    }
    const smtpHost = String(env.SMTP_HOST || '').trim();
    if (smtpHost && !isLoopbackHost(hostnameOf(smtpHost) || smtpHost)) {
        violations.push({ code: 'SMTP_RELAY_EXTERNAL', name: 'smtp-relay', detail: 'external smtp relay' });
    }
    PROVIDER_URL_ENV_KEYS.forEach((key) => {
        const value = String(env[key] || '').trim();
        if (!value) return;
        if (!isSandboxProviderUrl(value, env)) {
            violations.push({
                code: 'PROVIDER_URL_EXTERNAL',
                name: 'provider-url',
                detail: `${key} is not a sandbox host`
            });
        }
    });
    PM2_ENV_KEYS.forEach((key) => {
        if (String(env[key] || '').trim().toLowerCase() === PRODUCTION_PM2_NAME) {
            violations.push({ code: 'PM2_PRODUCTION_NAME', name: 'pm2-name', detail: `env ${key} is the production process` });
        }
    });
    return violations;
};

const EXTERNAL_API_DISABLED_MESSAGE = 'EXTERNAL_API_DISABLED: outbound financial provider calls are turned off';

const blockedProviderResult = (code, message) => ({
    success: false,
    code,
    stage: 'configuration',
    message,
    error: message,
    checks: [{ key: 'configuration', label: 'اتصال مزود الخدمة', status: 'failed', message }],
    operations: [],
    checkedCount: 0,
    failedCount: 0,
    processLog: message
});

module.exports = {
    EXTERNAL_API_DISABLED_MESSAGE,
    LOOPBACK_HOSTS,
    PRODUCTION_PM2_NAME,
    PROVIDER_URL_ENV_KEYS,
    blockedProviderResult,
    collectStagingEnvViolations,
    disabledSubsystemFlags,
    hostnameOf,
    isBullmqWorkersEnabled,
    isExplicitlyEnabled,
    isExternalApiEnabled,
    isFinancialSchedulersEnabled,
    isLoopbackHost,
    isMerchantWebhookWorkerEnabled,
    isSandboxProviderUrl,
    isStagingRuntime,
    logDisabledRuntimeSubsystems,
    resolveProviderBaseUrl,
    sandboxHostAllowlist
};
