'use strict';

const crypto = require('crypto');
const { isLocalRuntime, isSecureRuntime } = require('./runtimeEnv');

const LOCAL_DEV_ONLY_PEPPER = 'local-dev-api-key-pepper-not-for-production-32b';

const getApiKeyPepper = (env = process.env) => {
    const pepper = String(env.API_KEY_PEPPER || '').trim();
    if (pepper.length >= 32) return pepper;
    if (isSecureRuntime(env)) {
        throw new Error('API_KEY_PEPPER must contain at least 32 characters in staging and production.');
    }
    if (!isLocalRuntime(env)) {
        throw new Error('API_KEY_PEPPER is required outside local development and test.');
    }
    return LOCAL_DEV_ONLY_PEPPER;
};

const generateApiKey = () => `ak_live_${crypto.randomBytes(32).toString('hex')}`;

const hashApiKey = (plaintext, env = process.env) => {
    const value = String(plaintext || '');
    if (!value) return '';
    return crypto.createHmac('sha256', getApiKeyPepper(env)).update(value).digest('hex');
};

const apiKeyHint = (plaintext) => {
    const value = String(plaintext || '');
    if (value.length < 8) return '';
    return value.slice(-4);
};

const looksHashedApiKey = (value) => /^[0-9a-f]{64}$/i.test(String(value || '').trim());

const allowLegacyPlaintextApiKeys = (env = process.env) => (
    !isSecureRuntime(env)
    && ['1', 'true', 'yes', 'on'].includes(String(env.ALLOW_LEGACY_PLAINTEXT_API_KEYS || '').trim().toLowerCase())
);

module.exports = {
    allowLegacyPlaintextApiKeys,
    apiKeyHint,
    generateApiKey,
    getApiKeyPepper,
    hashApiKey,
    looksHashedApiKey
};
