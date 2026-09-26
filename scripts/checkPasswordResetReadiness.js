'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { isValidOtpEmail } = require('../utils/otpDeliveryChannel');

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

const isOn = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const isOff = (value) => ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());

const redact = (value) => String(value == null ? '' : value)
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, 'mongodb://[redacted]')
    .replace(/rediss?:\/\/\S+/gi, 'redis://[redacted]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s]+/g, '$1[redacted]')
    .replace(/:([^:@/\s]{3,})@/g, ':[redacted]@');

const parseArgs = (argv) => {
    const args = { envFile: '', appDir: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
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

const evaluateStaticChecks = (env) => {
    const lines = [];
    const add = (level, name, detail = '') => lines.push({ level, name, detail: redact(detail) });

    SMTP_KEYS.forEach((key) => {
        const present = String(env[key] == null ? '' : env[key]).trim() !== '';
        const portOk = key !== 'SMTP_PORT' || /^\d+$/.test(String(env[key] || '').trim());
        add(present && portOk ? 'PASS' : 'FAIL', key, present ? 'present' : 'missing');
    });
    add(isOn(env.EMAIL_OTP_ENABLED) ? 'PASS' : 'FAIL', 'EMAIL_OTP_ENABLED', 'must be true');
    add(String(env.OTP_DELIVERY_CHANNEL || '').trim().toLowerCase() === 'email' ? 'PASS' : 'FAIL', 'OTP_DELIVERY_CHANNEL', 'must be email');
    add(isOn(env.WHATSAPP_OTP_ENABLED) ? 'FAIL' : 'PASS', 'WHATSAPP_OTP_ENABLED', flagWord(env.WHATSAPP_OTP_ENABLED));
    add(isOn(env.WHATSAPP_LOGIN_OTP_ENABLED) ? 'FAIL' : 'PASS', 'WHATSAPP_LOGIN_OTP_ENABLED', flagWord(env.WHATSAPP_LOGIN_OTP_ENABLED));
    add('INFO', 'PASSWORD_RESET_EMAIL_ENABLED', flagWord(env.PASSWORD_RESET_EMAIL_ENABLED));
    add('INFO', 'PASSWORD_RESET_COMPLETE_WINDOW_SECONDS', String(effectiveCompleteWindowSeconds(env)));

    const secret = String(env.SESSION_SECRET || '');
    add(secret.length >= 32 ? 'PASS' : 'FAIL', 'SESSION_SECRET', secret ? 'present' : 'missing');
    add('INFO', 'SECURE_COOKIE', flagWord(env.SECURE_COOKIE));
    const store = String(env.SESSION_STORE || '').trim().toLowerCase();
    add(store ? 'INFO' : 'FAIL', 'SESSION_STORE', store || 'unset');

    if (isOff(env.REDIS_ENABLED)) {
        add(isOn(env.REDIS_REQUIRED) ? 'FAIL' : 'INFO', 'redis', isOn(env.REDIS_REQUIRED)
            ? 'REDIS_ENABLED is false while REDIS_REQUIRED is true'
            : 'REDIS_ENABLED is false; ping skipped');
    }
    return lines;
};

const countEmailChannels = async (db, collectionName, { emailOf, include }) => {
    const found = await db.listCollections({ name: collectionName }).toArray();
    if (!found.length) return { eligible: 0, unapproved: 0 };
    let eligible = 0;
    let unapproved = 0;
    const cursor = db.collection(collectionName).find({}, {
        projection: { role: 1, masterType: 1, otpDeliveryChannel: 1, email: 1, businessProfile: 1 }
    });
    for await (const doc of cursor) {
        if (!include(doc)) continue;
        const email = emailOf(doc);
        if (!isValidOtpEmail(email)) continue;
        if (String(doc.otpDeliveryChannel || '').trim().toLowerCase() === 'email') eligible += 1;
        else unapproved += 1;
    }
    return { eligible, unapproved };
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

const runReadiness = async (env) => {
    const lines = evaluateStaticChecks(env);
    const add = (level, name, detail = '') => lines.push({ level, name, detail: redact(detail) });
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
            const writable = hello.isWritablePrimary === true || hello.ismaster === true;
            add(hello.setName && writable ? 'PASS' : 'FAIL', 'mongodb', hello.setName && writable
                ? 'replica set writable primary'
                : 'replica set or writable primary missing');
            const dbSession = await mongoose.startSession();
            try {
                dbSession.startTransaction();
                await mongoose.connection.db.collection('users').findOne({}, { session: dbSession });
                await dbSession.abortTransaction();
                add('PASS', 'transaction', 'read then abort');
            } catch (error) {
                try {
                    await dbSession.abortTransaction();
                } catch (_abortError) {
                    // The transaction may already be closed.
                }
                add('FAIL', 'transaction', error.message);
            } finally {
                await dbSession.endSession();
            }
            if (!isOff(env.REDIS_ENABLED)) {
                try {
                    await pingRedis(env);
                    add('PASS', 'redis', 'PONG');
                } catch (error) {
                    add('FAIL', 'redis', error && error.code === 'REDIS_URL_MISSING' ? 'REDIS_URL missing' : error.message);
                }
            }
            await checkSessions(mongoose.connection.db, String(env.SESSION_STORE || '').trim().toLowerCase(), add);
            const users = await countEmailChannels(mongoose.connection.db, 'users', {
                include: (doc) => doc.role !== 'agent',
                emailOf: (doc) => doc.businessProfile && doc.businessProfile.email
            });
            const subAccounts = await countEmailChannels(mongoose.connection.db, 'subaccounts', {
                include: (doc) => doc.masterType === 'user',
                emailOf: (doc) => doc.email
            });
            add('INFO', 'users-email-channel', `eligible=${users.eligible} unapproved=${users.unapproved}`);
            add('INFO', 'subaccounts-email-channel', `eligible=${subAccounts.eligible} unapproved=${subAccounts.unapproved}`);
        } catch (error) {
            add('FAIL', 'mongodb', error.message);
        } finally {
            if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        }
    }
    const failed = lines.some((line) => line.level === 'FAIL');
    lines.push({ level: failed ? 'FAIL' : 'PASS', name: 'OVERALL', detail: failed ? 'FAIL' : 'PASS' });
    return { ok: !failed, lines };
};

const formatLine = (line) => (line.name === 'OVERALL'
    ? `OVERALL ${line.detail}`
    : `${line.level} ${line.name}${line.detail ? ` ${line.detail}` : ''}`);

const main = async (argv) => {
    const args = parseArgs(argv);
    if (!args.envFile) {
        console.log('FAIL env-file missing');
        console.log('OVERALL FAIL');
        return 1;
    }
    const envPath = path.resolve(args.appDir || process.cwd(), args.envFile);
    let text = '';
    try {
        text = fs.readFileSync(envPath, 'utf8');
    } catch (error) {
        console.log(`FAIL env-file ${redact(error.message)}`);
        console.log('OVERALL FAIL');
        return 1;
    }
    const result = await runReadiness(parseEnvText(text));
    result.lines.forEach((line) => console.log(formatLine(line)));
    return result.ok ? 0 : 1;
};

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((error) => {
            console.log(`FAIL readiness ${redact(error.message)}`);
            console.log('OVERALL FAIL');
            process.exit(1);
        });
}

module.exports = {
    evaluateStaticChecks,
    formatLine,
    parseArgs,
    parseEnvText,
    redact,
    runReadiness
};
