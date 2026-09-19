'use strict';

const { isEnabled, isProduction } = require('./runtimeEnv');

const extractDbName = (mongoUri) => {
    const raw = String(mongoUri || '').trim();
    if (!raw) return '';
    try {
        const normalized = raw.replace(/^mongodb(?:\+srv)?:\/\//i, 'http://');
        const parsed = new URL(normalized);
        return decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
    } catch (_error) {
        const match = raw.match(/\/([^/?]+)(?:\?|$)/);
        return match ? decodeURIComponent(match[1]) : '';
    }
};

const assertFinancialResetAllowed = ({
    env = process.env,
    dbName,
    scriptName = 'reset.js'
} = {}) => {
    if (isProduction(env)) {
        const error = new Error(
            `${scriptName} refuses to run when NODE_ENV=production. Financial wipes are never allowed in production.`
        );
        error.code = 'FINANCIAL_RESET_FORBIDDEN';
        throw error;
    }

    if (!isEnabled(env.ALLOW_FINANCIAL_RESET)) {
        const error = new Error(
            `${scriptName} refused: set ALLOW_FINANCIAL_RESET=true to acknowledge a destructive financial wipe.`
        );
        error.code = 'FINANCIAL_RESET_NOT_ACKNOWLEDGED';
        throw error;
    }

    const expectedName = String(env.CONFIRM_DB_NAME || '').trim();
    const actualName = String(dbName || '').trim();
    if (!expectedName) {
        const error = new Error(
            `${scriptName} refused: CONFIRM_DB_NAME must match the connected database name.`
        );
        error.code = 'FINANCIAL_RESET_DB_UNCONFIRMED';
        throw error;
    }
    if (!actualName || actualName !== expectedName) {
        const error = new Error(
            `${scriptName} refused: connected database "${actualName || '(unknown)'}" does not match CONFIRM_DB_NAME="${expectedName}".`
        );
        error.code = 'FINANCIAL_RESET_DB_MISMATCH';
        throw error;
    }

    return {
        dryRun: isEnabled(env.DRY_RUN) || isEnabled(env.FINANCIAL_RESET_DRY_RUN),
        dbName: actualName
    };
};

module.exports = {
    assertFinancialResetAllowed,
    extractDbName
};
