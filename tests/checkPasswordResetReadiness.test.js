'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
    evaluateStaticChecks,
    formatLine,
    parseArgs,
    parseEnvText,
    redact
} = require('../scripts/checkPasswordResetReadiness');

const SECRET = 'smtp-pass-not-real';
const MONGO_SECRET_URI = 'mongodb://owner:s3cret-pass@10.1.1.8:27017/ahrampay?replicaSet=rs0';
const REDIS_SECRET_URI = 'redis://default:redis-secret@10.1.1.9:6379/0';

describe('password reset readiness parsing', () => {
    test('parseArgs reads the env file and app dir', () => {
        expect(parseArgs(['--env-file', '.env', '--app-dir', 'C:\\app'])).toEqual({
            envFile: '.env',
            appDir: 'C:\\app'
        });
    });

    test('parseEnvText keeps quoted values and ignores comments', () => {
        const env = parseEnvText(`
# comment
export SMTP_FROM="Ahram Pay <noreply@ahrampay.com>"
SMTP_PASS='${SECRET}'
NOT A LINE
`);
        expect(env.SMTP_FROM).toBe('Ahram Pay <noreply@ahrampay.com>');
        expect(env.SMTP_PASS).toBe(SECRET);
        expect(env['NOT A LINE']).toBeUndefined();
    });

    test('redact removes mongo and redis URIs and inline passwords', () => {
        const text = redact(`connect ${MONGO_SECRET_URI} and ${REDIS_SECRET_URI} user:s3cret-pass@host`);
        expect(text).not.toContain('s3cret-pass');
        expect(text).not.toContain('redis-secret');
        expect(text).not.toContain('10.1.1.8');
        expect(text).not.toContain('10.1.1.9');
        expect(text).toContain('mongodb://[redacted]');
        expect(text).toContain('redis://[redacted]');
    });

    test('static checks fail closed without printing secret values', () => {
        const lines = evaluateStaticChecks({
            SMTP_HOST: 'smtp.example.net',
            SMTP_PORT: '587',
            SMTP_USER: 'mailer',
            SMTP_PASS: SECRET,
            SMTP_FROM: 'Ahram Pay <noreply@ahrampay.com>',
            EMAIL_OTP_ENABLED: 'true',
            OTP_DELIVERY_CHANNEL: 'email',
            WHATSAPP_OTP_ENABLED: 'true',
            WHATSAPP_LOGIN_OTP_ENABLED: 'false',
            REDIS_ENABLED: 'false',
            SESSION_SECRET: 'short',
            SESSION_STORE: 'mongo',
            SECURE_COOKIE: 'true',
            MONGO_URI: MONGO_SECRET_URI
        });
        const text = lines.map(formatLine).join('\n');
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(MONGO_SECRET_URI);
        expect(text).not.toContain('s3cret');
        expect(lines.find((line) => line.name === 'WHATSAPP_OTP_ENABLED').level).toBe('FAIL');
        expect(lines.find((line) => line.name === 'WHATSAPP_LOGIN_OTP_ENABLED').level).toBe('PASS');
        expect(lines.find((line) => line.name === 'SESSION_SECRET').level).toBe('FAIL');
        expect(lines.find((line) => line.name === 'redis').level).toBe('INFO');
        expect(lines.find((line) => line.name === 'EMAIL_OTP_ENABLED').level).toBe('PASS');
    });

    test('a disabled redis is a failure only when redis is required', () => {
        const required = evaluateStaticChecks({ REDIS_ENABLED: 'false', REDIS_REQUIRED: 'true' });
        expect(required.find((line) => line.name === 'redis').level).toBe('FAIL');
        const skipped = evaluateStaticChecks({ REDIS_ENABLED: 'false' });
        expect(skipped.find((line) => line.name === 'redis').level).toBe('INFO');
    });

    test('reports the reset flag and the effective completion window as info', () => {
        const lines = evaluateStaticChecks({});
        expect(lines.find((line) => line.name === 'PASSWORD_RESET_EMAIL_ENABLED')).toMatchObject({
            level: 'INFO',
            detail: 'unset'
        });
        expect(lines.find((line) => line.name === 'PASSWORD_RESET_COMPLETE_WINDOW_SECONDS')).toMatchObject({
            level: 'INFO',
            detail: '600'
        });
        const clamped = evaluateStaticChecks({ PASSWORD_RESET_COMPLETE_WINDOW_SECONDS: '5' });
        expect(clamped.find((line) => line.name === 'PASSWORD_RESET_COMPLETE_WINDOW_SECONDS').detail).toBe('60');
    });
});

describe('password reset readiness makes no writes', () => {
    let replSet;

    beforeAll(async () => {
        replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
        await mongoose.connect(replSet.getUri(), { autoIndex: false, autoCreate: false });
        const db = mongoose.connection.db;
        await db.collection('users').insertMany([
            { role: 'user', otpDeliveryChannel: 'email', businessProfile: { email: 'owner@example.com' } },
            { role: 'user', otpDeliveryChannel: 'whatsapp', businessProfile: { email: 'plain@example.com' } },
            { role: 'agent', otpDeliveryChannel: 'email', businessProfile: { email: 'agent@example.com' } }
        ]);
        await db.collection('subaccounts').insertMany([
            { masterType: 'user', otpDeliveryChannel: 'email', email: 'sub@example.com' },
            { masterType: 'user', otpDeliveryChannel: 'whatsapp', email: 'sub-plain@example.com' },
            { masterType: 'company', otpDeliveryChannel: 'email', email: 'company@example.com' }
        ]);
        await db.createCollection('sessions');
    }, 120000);

    afterAll(async () => {
        await mongoose.disconnect();
        if (replSet) await replSet.stop();
    });

    test('the script leaves collection names and document counts unchanged', async () => {
        const snapshot = async () => {
            const collections = await mongoose.connection.db.listCollections().toArray();
            const names = collections.map((item) => item.name).sort();
            const counts = {};
            for (const name of names) {
                counts[name] = await mongoose.connection.db.collection(name).countDocuments();
            }
            return { names, counts };
        };
        const before = await snapshot();
        const envPath = path.join(os.tmpdir(), `reset-readiness-${Date.now()}.env`);
        const sessionSecret = 'session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
        fs.writeFileSync(envPath, [
            `MONGO_URI=${replSet.getUri()}`,
            'REDIS_ENABLED=false',
            'REDIS_REQUIRED=false',
            'SESSION_STORE=mongo',
            `SESSION_SECRET=${sessionSecret}`,
            'SECURE_COOKIE=true',
            'SMTP_HOST=smtp.example.net',
            'SMTP_PORT=587',
            'SMTP_USER=mailer',
            `SMTP_PASS=${SECRET}`,
            'SMTP_FROM=Ahram Pay <noreply@ahrampay.com>',
            'EMAIL_OTP_ENABLED=true',
            'OTP_DELIVERY_CHANNEL=email',
            'WHATSAPP_OTP_ENABLED=false',
            'WHATSAPP_LOGIN_OTP_ENABLED=false',
            'PASSWORD_RESET_EMAIL_ENABLED=false',
            'PASSWORD_RESET_COMPLETE_WINDOW_SECONDS=600'
        ].join('\n'));
        const result = spawnSync(process.execPath, [
            path.join(__dirname, '../scripts/checkPasswordResetReadiness.js'),
            '--env-file',
            envPath
        ], { encoding: 'utf8' });
        fs.unlinkSync(envPath);
        const after = await snapshot();
        expect(after).toEqual(before);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('OVERALL PASS');
        expect(result.stdout).toContain('PASS transaction read then abort');
        expect(result.stdout).toContain('INFO users-email-channel eligible=1 unapproved=1');
        expect(result.stdout).toContain('INFO subaccounts-email-channel eligible=1 unapproved=1');
        expect(result.stdout).toContain('INFO redis REDIS_ENABLED is false; ping skipped');
        expect(result.stdout).not.toContain(replSet.getUri());
        expect(result.stdout).not.toContain('mongodb://');
        expect(result.stdout).not.toContain(SECRET);
        expect(result.stdout).not.toContain(sessionSecret);
    });
});
