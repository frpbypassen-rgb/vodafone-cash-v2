'use strict';

// Switch values use the same tokens as utils/passwordResetAvailability.js.
// Outside staging, unset stays enabled and only false/0/no/off disables.
// In staging, unset stays disabled and only 1/true/yes/on enables.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const STAGING_KEYS = ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT'];
const PROVIDER_URL_ENV_KEYS = ['ZAYN_AGGREGATOR_URL', 'ZAYNPAY_URL', 'ZAYN_EXECUTOR_API_URL'];
const PM2_ENV_KEYS = ['name', 'PM2_NAME', 'PM2_APP_NAME'];
const PRODUCTION_PM2_NAME = 'ahram_core_api';

const isExplicitlyEnabled = (value) => TRUTHY.has(String(value ?? '').trim().toLowerCase());

const isExplicitlyDisabled = (value) => FALSY.has(String(value ?? '').trim().toLowerCase());

// Outside staging, an unset switch stays on so a production deploy keeps today's
// behavior. Only false/0/no/off turns it off. Staging fails closed: an unset
// switch is off, and only an explicit truthy value turns it on.
const isSwitchEnabled = (value, env = process.env) => {
    if (isExplicitlyEnabled(value)) return true;
    if (isExplicitlyDisabled(value)) return false;
    return !isStagingRuntime(env);
};

const isMerchantWebhookWorkerEnabled = (env = process.env) => (
    isSwitchEnabled(env.MERCHANT_WEBHOOK_WORKER_ENABLED, env)
);

const isExternalApiEnabled = (env = process.env) => isSwitchEnabled(env.EXTERNAL_API_ENABLED, env);

const isBullmqWorkersEnabled = (env = process.env) => isSwitchEnabled(env.BULLMQ_WORKERS_ENABLED, env);

const isFinancialSchedulersEnabled = (env = process.env) => (
    isSwitchEnabled(env.FINANCIAL_SCHEDULERS_ENABLED, env)
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
        + 'Outside staging an unset switch stays on; only false/0/no/off disables it. '
        + 'In staging an unset switch stays off.'
    );
    return disabled;
};

const configuredRuntimeModes = (env = process.env) => STAGING_KEYS
    .map((key) => ({ key, value: String(env[key] ?? '').trim().toLowerCase() }))
    .filter((item) => item.value);

// Any explicit `staging` value selects staging behavior, including a conflict.
// A conflict also refuses startup so a production process cannot keep serving
// with the switches silently off, and a staging process cannot be treated as production.
const stagingEnvConflict = (env = process.env) => {
    const modes = configuredRuntimeModes(env);
    const staging = modes.some((item) => item.value === 'staging');
    const other = modes.some((item) => item.value !== 'staging');
    return staging && other;
};

const isStagingRuntime = (env = process.env) => configuredRuntimeModes(env)
    .some((item) => item.value === 'staging');

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
    if (stagingEnvConflict(env)) {
        violations.push({
            code: 'STAGING_ENV_CONFLICT',
            name: 'runtime-env',
            detail: 'NODE_ENV, APP_ENV, and ENVIRONMENT disagree about staging'
        });
    }
    return violations;
};

const EXTERNAL_API_DISABLED_MESSAGE = 'EXTERNAL_API_DISABLED: outbound financial provider calls are turned off';
const API_EXECUTION_UNAVAILABLE_CODE = 'API_EXECUTION_UNAVAILABLE';

const apiQueueExecutionBlock = (env = process.env) => {
    if (!isExternalApiEnabled(env)) {
        return {
            code: API_EXECUTION_UNAVAILABLE_CODE,
            reason: 'EXTERNAL_API_DISABLED',
            message: 'تنفيذ المزود الخارجي متوقف. لم يتم توجيه العملية ولم يتغير رصيدها.'
        };
    }
    if (!isBullmqWorkersEnabled(env)) {
        return {
            code: API_EXECUTION_UNAVAILABLE_CODE,
            reason: 'BULLMQ_WORKERS_DISABLED',
            message: 'طابور تنفيذ المزود متوقف. لم يتم توجيه العملية ولم يتغير رصيدها.'
        };
    }
    return null;
};

const directProviderExecutionBlock = (env = process.env) => {
    if (!isExternalApiEnabled(env)) {
        return {
            code: API_EXECUTION_UNAVAILABLE_CODE,
            reason: 'EXTERNAL_API_DISABLED',
            message: 'تنفيذ ZaynPay متوقف. لم يُرسل الطلب إلى المزود ولم يتغير الرصيد.'
        };
    }
    return null;
};

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
    API_EXECUTION_UNAVAILABLE_CODE,
    EXTERNAL_API_DISABLED_MESSAGE,
    LOOPBACK_HOSTS,
    PRODUCTION_PM2_NAME,
    PROVIDER_URL_ENV_KEYS,
    apiQueueExecutionBlock,
    blockedProviderResult,
    collectStagingEnvViolations,
    directProviderExecutionBlock,
    disabledSubsystemFlags,
    hostnameOf,
    isBullmqWorkersEnabled,
    isExplicitlyDisabled,
    isExplicitlyEnabled,
    isSwitchEnabled,
    isExternalApiEnabled,
    isFinancialSchedulersEnabled,
    isLoopbackHost,
    isMerchantWebhookWorkerEnabled,
    isSandboxProviderUrl,
    isStagingRuntime,
    stagingEnvConflict,
    logDisabledRuntimeSubsystems,
    resolveProviderBaseUrl,
    sandboxHostAllowlist
};
