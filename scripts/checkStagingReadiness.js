'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { isValidOtpEmail, resolveAccountOtpEmail } = require('../utils/otpDeliveryChannel');

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

const isOn = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const isOff = (value) => ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());

const sanitize = (value) => String(value == null ? '' : value)
    .replace(/(?:mongodb(?:\+srv)?|rediss?|smtps?):\/\/\S+/gi, '[redacted]')
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, '[redacted]')
    .replace(/\?[^\s'"<>]*/g, '')
    .replace(/[^\s:/@]+:[^\s:/@]+@[^\s:/@]+/g, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[redacted]')
    .replace(/\bENOTFOUND\s+\S+/gi, 'ENOTFOUND [redacted]')
    .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d{1,5})?\b/g, '[redacted]');

const PRODUCTION_APP_DIR = 'c:/users/administrator/desktop/vodafone-cash-v2';
const PRODUCTION_ENV_FILES = [
    'C:\\Users\\Administrator\\Desktop\\vodafone-cash-v2\\.env',
    'C:/Users/Administrator/Desktop/vodafone-cash-v2/.env'
];
// Names the app uses by default and in production deploy docs:
// .env.example, docker-compose.prod.yml, docs/operations/mongodb-production.md,
// docs/Deployment.md, docs/Backup-Recovery.md, docs/Disaster-Recovery.md.
const DEFAULT_DENIED_DATABASES = Object.freeze([
    'vodafone_cash_system',
    'vodafone_cash'
]);
const PRODUCTION_VALUE_KEYS = ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT'];

const parseArgs = (argv) => {
    const args = { envFile: '', appDir: '', appDirProvided: false, denyDb: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--') continue;
        if (token === '--env-file') args.envFile = argv[index + 1] || '';
        if (token === '--app-dir') {
            args.appDirProvided = true;
            args.appDir = argv[index + 1] || '';
        }
        if (token === '--deny-db') args.denyDb.push(argv[index + 1] || '');
        if (token === '--env-file' || token === '--app-dir' || token === '--deny-db') index += 1;
    }
    return args;
};

const parseEnvText = (text) => {
    const env = {};
    String(text || '').split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
        const separator = body.indexOf('=');
        if (separator <= 0) return;
        const key = body.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
        let value = body.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    });
    return env;
};

const effectiveCompleteWindowSeconds = (env) => {
    const parsed = Number(env.PASSWORD_RESET_COMPLETE_WINDOW_SECONDS);
    const seconds = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 600;
    return Math.min(600, Math.max(60, seconds));
};

const flagWord = (value) => {
    const text = String(value == null ? '' : value).trim();
    if (!text) return 'unset';
    if (/^(1|0|true|false|yes|no|on|off)$/i.test(text)) return text.toLowerCase();
    return 'set';
};

const envLabel = (value) => {
    const text = String(value == null ? '' : value).trim();
    if (!text) return 'unset';
    if (/^(production|staging|development|test|local)$/i.test(text)) return text.toLowerCase();
    return 'set';
};

const canonicalPath = (value) => String(value || '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

const isProductionAppDir = (value) => {
    const raw = canonicalPath(value);
    if (!raw) return false;
    if (raw === PRODUCTION_APP_DIR) return true;
    return canonicalPath(path.resolve(String(value))) === PRODUCTION_APP_DIR;
};

const isPlaceholderAppDir = (value) => String(value || '').trim().toLowerCase() === '<staging_path>';

const isProductionEnvironment = (env = {}) => (
    PRODUCTION_VALUE_KEYS.some((key) => String(env[key] || '').trim().toLowerCase() === 'production')
);

const isProductionMarker = (env = {}) => {
    if (isOn(env.PRODUCTION)) return true;
    return Object.entries(env).some(([key, value]) => (
        /^(DEPLOY|TENANT)(_|$)/i.test(key)
        && String(value || '').trim().toLowerCase() === 'production'
    ));
};

const databaseNameFromUri = (uri) => {
    const text = String(uri || '').trim();
    if (!text) return { name: '', explicit: false };
    const match = text.match(/^(?:mongodb(?:\+srv)?:\/\/)(?:[^/?#\s]*@)?[^/?#\s]*\/([^/?#\s]+)/i);
    if (!match || !match[1]) return { name: '', explicit: false };
    try {
        const name = decodeURIComponent(match[1]).trim();
        return name ? { name, explicit: true } : { name: '', explicit: false };
    } catch (_error) {
        return { name: '', explicit: false };
    }
};

const splitDatabaseList = (value) => String(value || '')
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const deniedDatabaseNames = ({ env = {}, processEnv = {}, denyDb = [] } = {}) => {
    const names = new Set(DEFAULT_DENIED_DATABASES.map((name) => name.toLowerCase()));
    denyDb.forEach((item) => splitDatabaseList(item).forEach((name) => names.add(name)));
    splitDatabaseList(env.STAGING_CHECK_DENY_DBS).forEach((name) => names.add(name));
    splitDatabaseList(processEnv.STAGING_CHECK_DENY_DBS).forEach((name) => names.add(name));
    return names;
};

const mongoUriFromEnvText = (text) => {
    let found = '';
    String(text || '').split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
        const separator = body.indexOf('=');
        if (separator <= 0) return;
        if (body.slice(0, separator).trim() !== 'MONGO_URI') return;
        let value = body.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        found = value;
    });
    return found;
};

const readProductionDatabaseName = (filePaths = PRODUCTION_ENV_FILES) => {
    for (const filePath of filePaths) {
        try {
            if (!filePath || !fs.existsSync(filePath)) continue;
            const parsed = databaseNameFromUri(mongoUriFromEnvText(fs.readFileSync(filePath, 'utf8')));
            if (parsed.explicit) return parsed.name;
        } catch (_error) {
            // The production env file is optional. Skip it when it cannot be read.
        }
    }
    return '';
};

const resetFlagLevel = (value) => {
    const word = flagWord(value);
    if (word === 'unset' || isOff(word)) return 'PASS';
    if (isOn(word)) return 'WARN';
    return 'FAIL';
};

const closedFlagLevel = (value) => {
    const word = flagWord(value);
    if (word === 'unset' || isOff(word)) return 'PASS';
    return 'FAIL';
};

const emailChannelCounts = (docs, include) => {
    const counts = { eligible: 0, unapproved: 0 };
    (docs || []).forEach((doc) => {
        if (include && !include(doc)) return;
        const email = resolveAccountOtpEmail(doc);
        if (!isValidOtpEmail(email)) return;
        if (String(doc.otpDeliveryChannel || '').trim().toLowerCase() === 'email') counts.eligible += 1;
        else counts.unapproved += 1;
    });
    return counts;
};

const evaluateStaticChecks = (env) => {
    const lines = [];
    const add = (level, name, detail = '') => lines.push({ level, name, detail: sanitize(detail) });

    SMTP_KEYS.forEach((key) => {
        const present = String(env[key] == null ? '' : env[key]).trim() !== '';
        const portOk = key !== 'SMTP_PORT' || /^\d+$/.test(String(env[key] || '').trim());
        add(present && portOk ? 'PASS' : 'FAIL', key, present ? 'present' : 'missing');
    });
    add(isOn(env.EMAIL_OTP_ENABLED) ? 'PASS' : 'FAIL', 'EMAIL_OTP_ENABLED', 'must be true');
    add(String(env.OTP_DELIVERY_CHANNEL || '').trim().toLowerCase() === 'email' ? 'PASS' : 'FAIL', 'OTP_DELIVERY_CHANNEL', 'must be email');
    add(closedFlagLevel(env.WHATSAPP_OTP_ENABLED), 'WHATSAPP_OTP_ENABLED', flagWord(env.WHATSAPP_OTP_ENABLED));
    add(closedFlagLevel(env.WHATSAPP_LOGIN_OTP_ENABLED), 'WHATSAPP_LOGIN_OTP_ENABLED', flagWord(env.WHATSAPP_LOGIN_OTP_ENABLED));
    add(resetFlagLevel(env.PASSWORD_RESET_EMAIL_ENABLED), 'PASSWORD_RESET_EMAIL_ENABLED', flagWord(env.PASSWORD_RESET_EMAIL_ENABLED));
    add('INFO', 'PASSWORD_RESET_COMPLETE_WINDOW_SECONDS', String(effectiveCompleteWindowSeconds(env)));

    const secret = String(env.SESSION_SECRET || '');
    add(secret.length >= 32 ? 'PASS' : 'FAIL', 'SESSION_SECRET', secret ? 'present' : 'missing');
    add('INFO', 'SECURE_COOKIE', flagWord(env.SECURE_COOKIE));
    const store = String(env.SESSION_STORE || '').trim().toLowerCase();
    add(store === 'mongo' || store === 'redis' ? 'PASS' : 'FAIL', 'SESSION_STORE', store || 'unset');

    if (isOff(env.REDIS_ENABLED)) {
        add(isOn(env.REDIS_REQUIRED) ? 'FAIL' : 'INFO', 'redis', isOn(env.REDIS_REQUIRED)
            ? 'REDIS_ENABLED is false while REDIS_REQUIRED is true'
            : 'REDIS_ENABLED is false; ping skipped');
    }
    return lines;
};

const countCollection = async (db, collectionName, include) => {
    const found = await db.listCollections({ name: collectionName }).toArray();
    if (!found.length) return { eligible: 0, unapproved: 0 };
    const docs = await db.collection(collectionName).find({}, {
        projection: { role: 1, masterType: 1, otpDeliveryChannel: 1, email: 1, businessProfile: 1 }
    }).toArray();
    return emailChannelCounts(docs, include);
};

const checkSessions = async (db, store, add) => {
    if (store === 'mongo') {
        const found = await db.listCollections({ name: 'sessions' }).toArray();
        if (!found.length) {
            add('FAIL', 'sessions', 'collection is not present');
            return;
        }
        await db.collection('sessions').countDocuments();
        add('PASS', 'sessions', 'countable');
        return;
    }
    if (store === 'redis') {
        add('INFO', 'sessions', 'redis store uses the redis ping');
        return;
    }
    add('FAIL', 'sessions', 'SESSION_STORE is not mongo or redis');
};

const errorText = (error) => {
    const parts = [error && error.message, error && error.code];
    if (error && Array.isArray(error.errors)) {
        error.errors.forEach((item) => parts.push(item && item.message));
    }
    return parts.filter(Boolean).join(' ');
};

const pingRedis = async (env) => {
    const Redis = require('ioredis');
    const url = String(env.REDIS_URL || env.REDIS_URI || '').trim();
    if (!url) {
        const error = new Error('REDIS_URL missing');
        error.code = 'REDIS_URL_MISSING';
        throw error;
    }
    const client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 4000,
        enableOfflineQueue: false,
        retryStrategy: () => null
    });
    client.on('error', () => {});
    try {
        await client.connect();
        const pong = await client.ping();
        if (pong !== 'PONG') throw new Error('PING did not return PONG');
    } finally {
        try {
            client.disconnect();
        } catch (_error) {
            // The socket may already be closed.
        }
    }
};

const databaseRefusal = (env, { processEnv = process.env, denyDb = [], productionDatabaseName = '' } = {}) => {
    const parsed = databaseNameFromUri(env.MONGO_URI || '');
    if (!parsed.explicit) return 'name missing';
    if (deniedDatabaseNames({ env, processEnv, denyDb }).has(parsed.name.toLowerCase())) return 'denied';
    if (productionDatabaseName && parsed.name.toLowerCase() === productionDatabaseName.toLowerCase()) {
        return 'matches production env';
    }
    return '';
};

const blockedResult = (lines) => {
    lines.push({ level: 'FAIL', name: 'OVERALL', detail: 'FAIL' });
    return { ok: false, lines };
};

const runStagingCheck = async (env, { appDir, processEnv = process.env, denyDb = [], productionDatabaseName = '' } = {}) => {
    const lines = [];
    const add = (level, name, detail = '', extra = {}) => lines.push({
        level,
        name,
        detail: sanitize(detail),
        ...extra
    });
    const resolvedDir = path.resolve(String(appDir || ''));
    add('INFO', 'app-dir', resolvedDir);
    add('INFO', 'NODE_ENV', envLabel(env.NODE_ENV || processEnv.NODE_ENV));
    add('INFO', 'APP_ENV', envLabel(env.APP_ENV || processEnv.APP_ENV));
    add('INFO', 'ENVIRONMENT', envLabel(env.ENVIRONMENT || processEnv.ENVIRONMENT));
    const production = isProductionEnvironment(env) || isProductionEnvironment(processEnv)
        || isProductionMarker(env) || isProductionMarker(processEnv);
    if (production) {
        add('FAIL', 'environment', isProductionEnvironment(env) || isProductionEnvironment(processEnv)
            ? 'production'
            : 'marker');
    }
    evaluateStaticChecks(env).forEach((line) => lines.push(line));
    if (production) return blockedResult(lines);

    const databaseDetail = databaseRefusal(env, { processEnv, denyDb, productionDatabaseName });
    if (databaseDetail) {
        add('FAIL', 'database', databaseDetail);
        return blockedResult(lines);
    }

    const uri = String(env.MONGO_URI || '').trim();
    if (!uri) {
        add('FAIL', 'database', 'name missing');
        return blockedResult(lines);
    } else {
        mongoose.set('autoIndex', false);
        mongoose.set('autoCreate', false);
        mongoose.set('strictQuery', true);
        try {
            await mongoose.connect(uri, {
                autoIndex: false,
                autoCreate: false,
                serverSelectionTimeoutMS: 10000,
                family: 4
            });
            const hello = await mongoose.connection.db.admin().command({ hello: 1 });
            const detected = Boolean(hello && hello.setName);
            add(detected ? 'PASS' : 'FAIL', detected
                ? 'replica-set topology detected'
                : 'replica-set topology not detected', '', { exact: true });
            if (!isOff(env.REDIS_ENABLED)) {
                try {
                    await pingRedis(env);
                    add('PASS', 'redis', 'PONG');
                } catch (error) {
                    add('FAIL', 'redis', error && error.code === 'REDIS_URL_MISSING' ? 'REDIS_URL missing' : errorText(error));
                }
            }
            await checkSessions(mongoose.connection.db, String(env.SESSION_STORE || '').trim().toLowerCase(), add);
            const users = await countCollection(mongoose.connection.db, 'users', (doc) => doc.role !== 'agent');
            const subAccounts = await countCollection(
                mongoose.connection.db,
                'subaccounts',
                (doc) => doc.masterType === 'user'
            );
            add('INFO', 'users-email-channel', `eligible=${users.eligible} unapproved=${users.unapproved}`);
            add('INFO', 'subaccounts-email-channel', `eligible=${subAccounts.eligible} unapproved=${subAccounts.unapproved}`);
        } catch (error) {
            add('FAIL', 'mongodb', errorText(error));
        } finally {
            if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        }
    }
    const failed = lines.some((line) => line.level === 'FAIL');
    lines.push({ level: failed ? 'FAIL' : 'PASS', name: 'OVERALL', detail: failed ? 'FAIL' : 'PASS' });
    return { ok: !failed, lines };
};

const formatLine = (line) => {
    if (line.name === 'OVERALL') return `OVERALL ${line.detail}`;
    if (line.exact) return `${line.level} ${line.name}`;
    const detail = sanitize(line.detail || '');
    return `${line.level} ${line.name}${detail ? ` ${detail}` : ''}`;
};

const executeStagingCheck = async ({
    appDir = '',
    appDirProvided = false,
    envFile = '',
    denyDb = [],
    processEnv = process.env,
    productionEnvFiles = PRODUCTION_ENV_FILES
} = {}) => {
    const lines = [];
    const add = (level, name, detail = '') => lines.push({ level, name, detail: sanitize(detail) });
    const rawDir = String(appDir || '').trim();
    if (!appDirProvided || !rawDir) {
        add('FAIL', 'app-dir', 'missing');
        return blockedResult(lines);
    }
    if (isPlaceholderAppDir(rawDir)) {
        add('INFO', 'app-dir', '<STAGING_PATH>');
        add('FAIL', 'app-dir', 'placeholder');
        return blockedResult(lines);
    }
    if (isProductionAppDir(rawDir)) {
        add('FAIL', 'app-dir', 'production path');
        return blockedResult(lines);
    }
    if (!String(envFile || '').trim()) {
        add('FAIL', 'env-file', 'missing');
        return blockedResult(lines);
    }
    const resolvedDir = path.resolve(rawDir);
    const envPath = path.resolve(resolvedDir, envFile);
    let text = '';
    try {
        text = fs.readFileSync(envPath, 'utf8');
    } catch (_error) {
        add('FAIL', 'env-file', 'unreadable');
        return blockedResult(lines);
    }
    const env = parseEnvText(text);
    if (isProductionEnvironment(env) || isProductionEnvironment(processEnv)) {
        add('INFO', 'NODE_ENV', envLabel(env.NODE_ENV || processEnv.NODE_ENV));
        add('INFO', 'APP_ENV', envLabel(env.APP_ENV || processEnv.APP_ENV));
        add('INFO', 'ENVIRONMENT', envLabel(env.ENVIRONMENT || processEnv.ENVIRONMENT));
        add('FAIL', 'environment', 'production');
        return blockedResult(lines);
    }
    if (isProductionMarker(env) || isProductionMarker(processEnv)) {
        add('FAIL', 'environment', 'marker');
        return blockedResult(lines);
    }
    const productionDatabaseName = readProductionDatabaseName(productionEnvFiles);
    const databaseDetail = databaseRefusal(env, { processEnv, denyDb, productionDatabaseName });
    if (databaseDetail) {
        add('FAIL', 'database', databaseDetail);
        return blockedResult(lines);
    }
    return runStagingCheck(env, {
        appDir: resolvedDir,
        processEnv,
        denyDb,
        productionDatabaseName
    });
};

const main = async (argv) => {
    const args = parseArgs(argv);
    const result = await executeStagingCheck({
        appDir: args.appDir,
        appDirProvided: args.appDirProvided,
        envFile: args.envFile,
        denyDb: args.denyDb
    });
    result.lines.forEach((line) => console.log(formatLine(line)));
    return result.ok ? 0 : 1;
};

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((error) => {
            console.log(`FAIL staging-check ${sanitize(errorText(error))}`);
            console.log('OVERALL FAIL');
            process.exit(1);
        });
}

module.exports = {
    DEFAULT_DENIED_DATABASES,
    databaseNameFromUri,
    deniedDatabaseNames,
    emailChannelCounts,
    envLabel,
    evaluateStaticChecks,
    executeStagingCheck,
    formatLine,
    isProductionAppDir,
    isProductionEnvironment,
    main,
    parseArgs,
    parseEnvText,
    readProductionDatabaseName,
    runStagingCheck,
    sanitize
};
