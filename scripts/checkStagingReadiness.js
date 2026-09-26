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

const parseArgs = (argv) => {
    const args = { envFile: '', appDir: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--') continue;
        if (token === '--env-file') args.envFile = argv[index + 1] || '';
        if (token === '--app-dir') args.appDir = argv[index + 1] || '';
        if (token === '--env-file' || token === '--app-dir') index += 1;
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

const isProductionEnvironment = (env = {}) => (
    envLabel(env.NODE_ENV) === 'production' || envLabel(env.APP_ENV) === 'production'
);

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

const runStagingCheck = async (env, { appDir } = {}) => {
    const lines = [];
    const add = (level, name, detail = '', extra = {}) => lines.push({
        level,
        name,
        detail: sanitize(detail),
        ...extra
    });
    const resolvedDir = path.resolve(String(appDir || ''));
    add('INFO', 'app-dir', resolvedDir);
    add('INFO', 'NODE_ENV', envLabel(env.NODE_ENV));
    add('INFO', 'APP_ENV', envLabel(env.APP_ENV));
    const production = isProductionEnvironment(env) || isProductionEnvironment(process.env);
    if (production) {
        add('FAIL', 'environment', 'production');
    }
    evaluateStaticChecks(env).forEach((line) => lines.push(line));
    if (production) {
        lines.push({ level: 'FAIL', name: 'OVERALL', detail: 'FAIL' });
        return { ok: false, lines };
    }

    const uri = String(env.MONGO_URI || '').trim();
    if (!uri) {
        add('FAIL', 'mongodb', 'MONGO_URI missing');
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

const main = async (argv) => {
    const args = parseArgs(argv);
    if (!args.appDir || !args.envFile) {
        if (!args.appDir) console.log('FAIL app-dir missing');
        if (!args.envFile) console.log('FAIL env-file missing');
        console.log('OVERALL FAIL');
        return 1;
    }
    const appDir = path.resolve(args.appDir);
    const envPath = path.resolve(appDir, args.envFile);
    let text = '';
    try {
        text = fs.readFileSync(envPath, 'utf8');
    } catch (error) {
        console.log(`INFO app-dir ${sanitize(appDir)}`);
        console.log(`FAIL env-file ${sanitize(error.message)}`);
        console.log('OVERALL FAIL');
        return 1;
    }
    const result = await runStagingCheck(parseEnvText(text), { appDir });
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
    emailChannelCounts,
    envLabel,
    evaluateStaticChecks,
    formatLine,
    isProductionEnvironment,
    parseArgs,
    parseEnvText,
    runStagingCheck,
    sanitize
};
