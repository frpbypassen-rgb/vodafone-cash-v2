'use strict';

const {
    collectStagingEnvViolations,
    isSandboxProviderUrl,
    isStagingRuntime,
    PRODUCTION_PM2_NAME
} = require('./runtimeControls');
const {
    databaseNameFromUri,
    deniedDatabaseNames
} = require('../scripts/checkStagingReadiness');

const PROVIDER_COLLECTIONS = ['executorgroups', 'executorbots'];
const WEBHOOK_COLLECTIONS = ['merchantwebhookendpoints'];

const isConfiguredExternalUrl = (value, env) => {
    const text = String(value || '').trim();
    if (!text) return false;
    return !isSandboxProviderUrl(text, env);
};

const scanStagingDatabase = async (db, env = process.env) => {
    const violations = [];
    if (!db || typeof db.listCollections !== 'function') {
        violations.push({ code: 'DATABASE_UNAVAILABLE', name: 'database-config', detail: 'database handle missing' });
        return violations;
    }
    const listed = await db.listCollections().toArray();
    const existing = new Set((listed || []).map((item) => item && item.name).filter(Boolean));
    const readUrls = async (name, field) => {
        if (!existing.has(name)) return [];
        const rows = await db.collection(name).find({}, { projection: { [field]: 1 } }).toArray();
        return rows || [];
    };
    for (const name of PROVIDER_COLLECTIONS) {
        const rows = await readUrls(name, 'apiUrl');
        if (rows.some((row) => isConfiguredExternalUrl(row && row.apiUrl, env))) {
            violations.push({
                code: 'PROVIDER_URL_EXTERNAL',
                name: 'database-provider-url',
                detail: `${name} apiUrl is not a sandbox host`
            });
        }
    }
    for (const name of WEBHOOK_COLLECTIONS) {
        const rows = await readUrls(name, 'url');
        if (rows.some((row) => isConfiguredExternalUrl(row && row.url, env))) {
            violations.push({
                code: 'WEBHOOK_URL_EXTERNAL',
                name: 'database-webhook-url',
                detail: `${name} url is not a loopback or sandbox host`
            });
        }
    }
    return violations;
};

const collectProcessViolations = ({ env = process.env, processTitle = '' } = {}) => {
    const violations = [...collectStagingEnvViolations(env)];
    if (String(processTitle || '').trim().toLowerCase() === PRODUCTION_PM2_NAME) {
        violations.push({
            code: 'PM2_PRODUCTION_NAME',
            name: 'pm2-name',
            detail: 'process title is the production process'
        });
    }
    const parsed = databaseNameFromUri(env.MONGO_URI || '');
    if (!parsed.explicit) {
        violations.push({ code: 'DATABASE_NAME_MISSING', name: 'database', detail: 'name missing' });
    } else if (deniedDatabaseNames({ env, processEnv: env }).has(parsed.name.toLowerCase())) {
        violations.push({ code: 'DATABASE_PRODUCTION', name: 'database', detail: 'denied' });
    }
    return violations;
};

const assertStagingStartupSafe = async ({
    env = process.env,
    db,
    processTitle = ''
} = {}) => {
    if (!isStagingRuntime(env)) return { ok: true, violations: [] };
    const violations = collectProcessViolations({ env, processTitle });
    const databaseBlocked = violations.some((item) => (
        item.code === 'DATABASE_PRODUCTION' || item.code === 'DATABASE_NAME_MISSING'
    ));
    if (!databaseBlocked) {
        violations.push(...await scanStagingDatabase(db, env));
    }
    if (!violations.length) return { ok: true, violations };
    const summary = violations.map((item) => (
        `${item.code}${item.detail ? ` (${item.detail})` : ''}`
    )).join('; ');
    const error = new Error(`Staging startup refused: ${summary}`);
    error.code = 'STAGING_STARTUP_REFUSED';
    error.violations = violations;
    throw error;
};

module.exports = {
    PROVIDER_COLLECTIONS,
    WEBHOOK_COLLECTIONS,
    assertStagingStartupSafe,
    collectProcessViolations,
    scanStagingDatabase
};
