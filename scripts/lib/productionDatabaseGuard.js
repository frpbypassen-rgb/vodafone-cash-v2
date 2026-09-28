'use strict';

// Shared refusal checks for scripts that must never write to production.
// Connection strings are not included in error messages.

const PRODUCTION_DATABASE_NAMES = Object.freeze([
    'vodafone_cash_system',
    'vodafone_cash'
]);

const databaseNameFromUri = (uri) => {
    const text = String(uri || '').trim();
    if (!text) return '';
    const match = text.match(/^(?:mongodb(?:\+srv)?:\/\/)(?:[^/?#\s]*@)?[^/?#\s]*\/([^/?#\s]+)/i);
    if (!match || !match[1]) return '';
    try {
        return decodeURIComponent(match[1]).trim();
    } catch (_error) {
        return '';
    }
};

const isProductionEnvironment = (env = {}) => (
    ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT'].some((key) => (
        String(env[key] || '').trim().toLowerCase() === 'production'
    ))
);

const refusal = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
};

const assertExplicitNonProductionMongoUri = (env = process.env) => {
    if (isProductionEnvironment(env)) {
        throw refusal(
            'PRODUCTION_ENVIRONMENT',
            'Refusing to run because NODE_ENV, APP_ENV, or ENVIRONMENT is production.'
        );
    }
    const mongoUri = String(env.MONGO_URI || '').trim();
    if (!mongoUri) {
        throw refusal(
            'MONGO_URI_REQUIRED',
            'Refusing to run because MONGO_URI is required and must name an explicit non-production database.'
        );
    }
    const databaseName = databaseNameFromUri(mongoUri);
    if (!databaseName) {
        throw refusal(
            'DATABASE_NAME_REQUIRED',
            'Refusing to run because MONGO_URI does not include an explicit database name.'
        );
    }
    if (PRODUCTION_DATABASE_NAMES.includes(databaseName.toLowerCase())) {
        throw refusal(
            'PRODUCTION_DATABASE',
            'Refusing to run because the database name is a known production database.'
        );
    }
    return { databaseName };
};

const assertLocalSeedTarget = (env = process.env) => {
    const checked = assertExplicitNonProductionMongoUri(env);
    const uri = String(env.MONGO_URI || '').trim();
    const localHost = /^(?:mongodb(?:\+srv)?:\/\/)(?:[^@/?#\s]+@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i;
    if (!localHost.test(uri)) {
        throw refusal(
            'LOCAL_DATABASE_REQUIRED',
            'Refusing to run because this seed script only accepts a local MongoDB URI.'
        );
    }
    return checked;
};

const requireSecret = (env, name, minLength = 8) => {
    const value = String(env[name] || '');
    if (value.length < minLength || /[\r\n]/.test(value)) {
        throw refusal(
            'SECRET_REQUIRED',
            `${name} is required from the environment, must be at least ${minLength} characters, and is not printed.`
        );
    }
    return value;
};

module.exports = {
    PRODUCTION_DATABASE_NAMES,
    assertExplicitNonProductionMongoUri,
    assertLocalSeedTarget,
    databaseNameFromUri,
    isProductionEnvironment,
    requireSecret
};
