'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { isValidOtpEmail, resolveAccountOtpEmail } = require('../utils/otpDeliveryChannel');
const {
    emailChannelCounts,
    evaluateStaticChecks,
    formatLine,
    parseArgs,
    parseEnvText,
    runStagingCheck,
    sanitize
} = require('../scripts/checkStagingReadiness');

const SECRET = 'smtp-pass-not-real';
const MONGO_SECRET_URI = 'mongodb://owner:s3cret-pass@10.1.1.8:27017/ahrampay?replicaSet=rs0&authSource=admin';
const REDIS_SECRET_URI = 'redis://default:redis-secret@10.1.1.9:6379/0';

const userInclude = (doc) => doc.role !== 'agent';
const subInclude = (doc) => doc.masterType === 'user';

const expectCountsMatchResolver = (docs, include) => {
    const fromScript = emailChannelCounts(docs, include);
    const manual = { eligible: 0, unapproved: 0 };
    docs.forEach((doc) => {
        if (!include(doc)) return;
        const email = resolveAccountOtpEmail(doc);
        if (!isValidOtpEmail(email)) return;
        if (String(doc.otpDeliveryChannel || '').trim().toLowerCase() === 'email') manual.eligible += 1;
        else manual.unapproved += 1;
    });
    expect(fromScript).toEqual(manual);
    return fromScript;
};

describe('staging readiness parsing', () => {
    test('parseArgs requires the env file and app dir and has no production default', () => {
        expect(parseArgs(['--', '--env-file', '.env', '--app-dir', '<STAGING_PATH>'])).toEqual({
            envFile: '.env',
            appDir: '<STAGING_PATH>'
        });
        expect(parseArgs([])).toEqual({ envFile: '', appDir: '' });
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

    test('sanitize strips mongo URIs, redis URIs, smtp credentials, hosts, and query strings', () => {
        const samples = [
            `MongoServerSelectionError: connect ECONNREFUSED ${MONGO_SECRET_URI}`,
            'MongoServerSelectionError: connection timed out mongodb+srv://owner:s3cret-pass@cluster.example.net/ahrampay?retryWrites=true&w=majority',
            `Error: connect ECONNREFUSED 10.1.1.9:6379 ${REDIS_SECRET_URI}`,
            'ReplyError: NOAUTH Authentication failed. rediss://default:redis-secret@cache.internal:6379/0?password=redis-secret',
            'Invalid login: 535 Authentication failed smtp://mailer:smtp-pass-not-real@smtp.example.net:587?auth=login',
            'getaddrinfo ENOTFOUND db.internal.example'
        ];
        const text = samples.map(sanitize).join('\n');
        expect(text).not.toContain('s3cret-pass');
        expect(text).not.toContain('redis-secret');
        expect(text).not.toContain('smtp-pass-not-real');
        expect(text).not.toContain('10.1.1.8');
        expect(text).not.toContain('10.1.1.9');
        expect(text).not.toContain('cluster.example.net');
        expect(text).not.toContain('cache.internal');
        expect(text).not.toContain('smtp.example.net');
        expect(text).not.toContain('db.internal.example');
        expect(text).not.toContain('mongodb://');
        expect(text).not.toContain('mongodb+srv://');
        expect(text).not.toContain('redis://');
        expect(text).not.toContain('rediss://');
        expect(text).not.toContain('smtp://');
        expect(text).not.toContain('replicaSet');
        expect(text).not.toContain('authSource');
        expect(text).not.toContain('retryWrites');
        expect(text).toContain('MongoServerSelectionError');
        expect(text).toContain('ECONNREFUSED');
        expect(text).toContain('Authentication failed');
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
            WHATSAPP_OTP_ENABLED: 'false',
            WHATSAPP_LOGIN_OTP_ENABLED: 'false',
            PASSWORD_RESET_EMAIL_ENABLED: 'false',
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
        expect(lines.find((line) => line.name === 'WHATSAPP_OTP_ENABLED').level).toBe('PASS');
        expect(lines.find((line) => line.name === 'WHATSAPP_LOGIN_OTP_ENABLED').level).toBe('PASS');
        expect(lines.find((line) => line.name === 'PASSWORD_RESET_EMAIL_ENABLED')).toMatchObject({
            level: 'PASS',
            detail: 'false'
        });
        expect(lines.find((line) => line.name === 'SESSION_SECRET').level).toBe('FAIL');
        expect(lines.find((line) => line.name === 'SESSION_STORE').level).toBe('PASS');
        expect(lines.find((line) => line.name === 'redis').level).toBe('INFO');
        expect(lines.find((line) => line.name === 'EMAIL_OTP_ENABLED').level).toBe('PASS');
    });

    test('a truthy reset flag warns and a truthy WhatsApp OTP flag fails', () => {
        const lines = evaluateStaticChecks({
            WHATSAPP_OTP_ENABLED: 'true',
            PASSWORD_RESET_EMAIL_ENABLED: 'true'
        });
        expect(lines.find((line) => line.name === 'WHATSAPP_OTP_ENABLED').level).toBe('FAIL');
        expect(lines.find((line) => line.name === 'PASSWORD_RESET_EMAIL_ENABLED')).toMatchObject({
            level: 'WARN',
            detail: 'true'
        });
        const unset = evaluateStaticChecks({});
        expect(unset.find((line) => line.name === 'PASSWORD_RESET_EMAIL_ENABLED')).toMatchObject({
            level: 'PASS',
            detail: 'unset'
        });
    });

    test('a disabled redis is a failure only when redis is required', () => {
        const required = evaluateStaticChecks({ REDIS_ENABLED: 'false', REDIS_REQUIRED: 'true' });
        expect(required.find((line) => line.name === 'redis').level).toBe('FAIL');
        const skipped = evaluateStaticChecks({ REDIS_ENABLED: 'false' });
        expect(skipped.find((line) => line.name === 'redis').level).toBe('INFO');
    });

    test('refuses a production NODE_ENV or APP_ENV before connecting', async () => {
        const connect = jest.spyOn(mongoose, 'connect').mockRejectedValue(new Error('should not connect'));
        try {
            const byNode = await runStagingCheck({
                NODE_ENV: 'production',
                APP_ENV: 'staging',
                MONGO_URI: MONGO_SECRET_URI
            }, { appDir: path.join(os.tmpdir(), 'staging-app') });
            const byApp = await runStagingCheck({
                NODE_ENV: 'staging',
                APP_ENV: 'Production'
            }, { appDir: path.join(os.tmpdir(), 'staging-app') });
            const nodeText = byNode.lines.map(formatLine).join('\n');
            const appText = byApp.lines.map(formatLine).join('\n');
            expect(byNode.ok).toBe(false);
            expect(byApp.ok).toBe(false);
            expect(nodeText).toContain('INFO NODE_ENV production');
            expect(nodeText).toContain('FAIL environment production');
            expect(nodeText).toContain('OVERALL FAIL');
            expect(appText).toContain('INFO APP_ENV production');
            expect(nodeText).not.toContain('s3cret-pass');
            expect(nodeText).not.toContain('mongodb://');
            expect(connect).not.toHaveBeenCalled();
        } finally {
            connect.mockRestore();
        }
    });
});

describe('staging readiness email counts match resolveAccountOtpEmail', () => {
    const users = [
        { role: 'user', email: 'only@example.com', otpDeliveryChannel: 'email' },
        { role: 'user', businessProfile: { email: 'profile@example.com' }, otpDeliveryChannel: 'email' },
        {
            role: 'user',
            email: 'direct@example.com',
            businessProfile: { email: 'other@example.com' },
            otpDeliveryChannel: 'email'
        },
        {
            role: 'user',
            email: 'not-an-email',
            businessProfile: { email: 'good@example.com' },
            otpDeliveryChannel: 'email'
        },
        { role: 'user', email: 'bad-email', otpDeliveryChannel: 'email' },
        { role: 'user', otpDeliveryChannel: 'email' },
        { role: 'agent', email: 'agent@example.com', otpDeliveryChannel: 'email' },
        { role: 'user', email: 'plain@example.com', otpDeliveryChannel: 'whatsapp' }
    ];
    const subAccounts = [
        { masterType: 'user', email: 'sub@example.com', otpDeliveryChannel: 'email' },
        { masterType: 'user', businessProfile: { email: 'sub-profile@example.com' }, otpDeliveryChannel: 'email' },
        { masterType: 'user', email: 'sub-plain@example.com', otpDeliveryChannel: 'whatsapp' },
        { masterType: 'agent', email: 'agent-sub@example.com', otpDeliveryChannel: 'email' }
    ];

    test('counts direct email, profile email, both, invalid, empty, agents, and sub-account types', () => {
        const both = users[2];
        expect(resolveAccountOtpEmail(both)).toBe('direct@example.com');
        const badDirect = users[3];
        expect(resolveAccountOtpEmail(badDirect)).toBe('not-an-email');
        expect(isValidOtpEmail(resolveAccountOtpEmail(badDirect))).toBe(false);
        expect(expectCountsMatchResolver(users, userInclude)).toEqual({ eligible: 3, unapproved: 1 });
        expect(expectCountsMatchResolver(subAccounts, subInclude)).toEqual({ eligible: 2, unapproved: 1 });
        expect(emailChannelCounts([users[6]], userInclude)).toEqual({ eligible: 0, unapproved: 0 });
        expect(emailChannelCounts([subAccounts[3]], subInclude)).toEqual({ eligible: 0, unapproved: 0 });
    });
});

describe('staging readiness makes no writes', () => {
    let replSet;

    beforeAll(async () => {
        replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
        await mongoose.connect(replSet.getUri(), { autoIndex: false, autoCreate: false });
        const db = mongoose.connection.db;
        await db.collection('users').insertMany([
            { role: 'user', email: 'only@example.com', otpDeliveryChannel: 'email' },
            { role: 'user', businessProfile: { email: 'profile@example.com' }, otpDeliveryChannel: 'email' },
            {
                role: 'user',
                email: 'direct@example.com',
                businessProfile: { email: 'other@example.com' },
                otpDeliveryChannel: 'email'
            },
            {
                role: 'user',
                email: 'not-an-email',
                businessProfile: { email: 'good@example.com' },
                otpDeliveryChannel: 'email'
            },
            { role: 'user', email: 'bad-email', otpDeliveryChannel: 'email' },
            { role: 'user', otpDeliveryChannel: 'email' },
            { role: 'agent', email: 'agent@example.com', otpDeliveryChannel: 'email' },
            { role: 'user', email: 'plain@example.com', otpDeliveryChannel: 'whatsapp' }
        ]);
        await db.collection('subaccounts').insertMany([
            { masterType: 'user', email: 'sub@example.com', otpDeliveryChannel: 'email' },
            { masterType: 'user', businessProfile: { email: 'sub-profile@example.com' }, otpDeliveryChannel: 'email' },
            { masterType: 'user', email: 'sub-plain@example.com', otpDeliveryChannel: 'whatsapp' },
            { masterType: 'agent', email: 'agent-sub@example.com', otpDeliveryChannel: 'email' }
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
        const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-readiness-'));
        const envPath = path.join(appDir, 'staging.env');
        const sessionSecret = 'session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
        fs.writeFileSync(envPath, [
            `MONGO_URI=${replSet.getUri()}`,
            'NODE_ENV=staging',
            'APP_ENV=staging',
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
        const scriptPath = path.join(__dirname, '../scripts/checkStagingReadiness.js');
        const source = fs.readFileSync(scriptPath, 'utf8');
        expect(source).not.toContain('startTransaction');
        const result = spawnSync(process.execPath, [
            scriptPath,
            '--',
            '--app-dir',
            appDir,
            '--env-file',
            'staging.env'
        ], { encoding: 'utf8', cwd: appDir });
        fs.rmSync(appDir, { recursive: true, force: true });
        const after = await snapshot();
        const combined = `${result.stdout}\n${result.stderr}`;
        expect(after).toEqual(before);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`INFO app-dir ${appDir}`);
        expect(result.stdout).toContain('INFO NODE_ENV staging');
        expect(result.stdout).toContain('INFO APP_ENV staging');
        expect(result.stdout).toContain('PASS replica-set topology detected');
        expect(result.stdout).not.toContain('transaction');
        expect(result.stdout).toContain('OVERALL PASS');
        expect(result.stdout).toContain('INFO users-email-channel eligible=3 unapproved=1');
        expect(result.stdout).toContain('INFO subaccounts-email-channel eligible=2 unapproved=1');
        expect(result.stdout).toContain('PASS PASSWORD_RESET_EMAIL_ENABLED false');
        expect(result.stdout).toContain('INFO redis REDIS_ENABLED is false; ping skipped');
        expect(combined).not.toContain(replSet.getUri());
        expect(combined).not.toContain('mongodb://');
        expect(combined).not.toContain(SECRET);
        expect(combined).not.toContain(sessionSecret);
    });
});
