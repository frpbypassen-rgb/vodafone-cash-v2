'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('mongoose', () => {
    const connection = {
        readyState: 0,
        db: {
            admin: () => ({ command: async () => ({ setName: 'rs0' }) }),
            listCollections: () => ({ toArray: async () => [{ name: 'sessions' }, { name: 'users' }, { name: 'subaccounts' }] }),
            collection: () => ({
                find: () => ({ toArray: async () => [] }),
                countDocuments: async () => 0
            })
        }
    };
    return {
        connect: jest.fn(async () => {
            connection.readyState = 1;
        }),
        disconnect: jest.fn(async () => {
            connection.readyState = 0;
        }),
        set: jest.fn(),
        connection,
        startSession: jest.fn()
    };
});
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    connect: jest.fn(async () => {}),
    ping: jest.fn(async () => 'PONG'),
    disconnect: jest.fn()
})));
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const mongoose = require('mongoose');
const Redis = require('ioredis');
const nodemailer = require('nodemailer');
const {
    executeStagingCheck,
    formatLine,
    main
} = require('../scripts/checkStagingReadiness');

const SECRET = 'staging-secret-not-real';
const SAFE_URI = `mongodb://staging-user:${SECRET}@127.0.0.1:27017/staging_readiness?replicaSet=rs0`;
const absentProductionEnv = path.join(os.tmpdir(), 'missing-production-env-not-real');

const writeEnv = (dir, body) => {
    fs.writeFileSync(path.join(dir, 'staging.env'), body);
};

const baseEnv = (extra = '') => [
    'NODE_ENV=staging',
    'APP_ENV=staging',
    'ENVIRONMENT=staging',
    'REDIS_ENABLED=false',
    'REDIS_REQUIRED=false',
    'SESSION_STORE=mongo',
    `SESSION_SECRET=${'session-secret-0123456789-abcdefghijklmnopqrstuvwxyz'}`,
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
    `MONGO_URI=${SAFE_URI}`,
    extra
].filter(Boolean).join('\n');

const run = async (appDir, envBody, extra = {}) => {
    writeEnv(appDir, envBody);
    const result = await executeStagingCheck({
        appDir,
        appDirProvided: extra.appDirProvided !== false,
        envFile: extra.envFile === undefined ? 'staging.env' : extra.envFile,
        denyDb: extra.denyDb || [],
        processEnv: extra.processEnv || { NODE_ENV: 'test' },
        productionEnvFiles: extra.productionEnvFiles || [absentProductionEnv]
    });
    return { result, text: result.lines.map(formatLine).join('\n') };
};

describe('staging readiness refusals make no connections', () => {
    let appDir;

    beforeEach(() => {
        jest.clearAllMocks();
        appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-refusal-'));
    });

    afterEach(() => {
        fs.rmSync(appDir, { recursive: true, force: true });
    });

    const expectNoConnection = (text) => {
        expect(mongoose.connect).not.toHaveBeenCalled();
        expect(mongoose.startSession).not.toHaveBeenCalled();
        expect(Redis).not.toHaveBeenCalled();
        expect(nodemailer.createTransport).not.toHaveBeenCalled();
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('mongodb://');
        expect(text).not.toContain('127.0.0.1');
        expect(text).toContain('OVERALL FAIL');
    };

    test('refuses when --app-dir was not passed', async () => {
        const result = await executeStagingCheck({
            appDir: '',
            appDirProvided: false,
            envFile: 'staging.env',
            processEnv: { NODE_ENV: 'test' },
            productionEnvFiles: [absentProductionEnv]
        });
        const text = result.lines.map(formatLine).join('\n');
        expect(text).toContain('FAIL app-dir missing');
        expectNoConnection(text);
    });

    test('refuses the literal <STAGING_PATH> placeholder', async () => {
        const code = await main([
            '--',
            '--app-dir',
            '<STAGING_PATH>',
            '--env-file',
            path.join(appDir, 'staging.env')
        ]);
        writeEnv(appDir, baseEnv());
        const direct = await executeStagingCheck({
            appDir: '<STAGING_PATH>',
            appDirProvided: true,
            envFile: path.join(appDir, 'staging.env'),
            processEnv: { NODE_ENV: 'test' },
            productionEnvFiles: [absentProductionEnv]
        });
        const text = direct.lines.map(formatLine).join('\n');
        expect(code).toBe(1);
        expect(text).toContain('FAIL app-dir placeholder');
        expectNoConnection(text);
    });

    test.each([
        'C:\\Users\\Administrator\\Desktop\\vodafone-cash-v2',
        'C:\\Users\\Administrator\\Desktop\\vodafone-cash-v2\\',
        'c:/users/administrator/desktop/vodafone-cash-v2/',
        'C:/Users/Administrator/Desktop/vodafone-cash-v2'
    ])('refuses the production app directory %s', async (dir) => {
        writeEnv(appDir, baseEnv());
        const result = await executeStagingCheck({
            appDir: dir,
            appDirProvided: true,
            envFile: path.join(appDir, 'staging.env'),
            processEnv: { NODE_ENV: 'test' },
            productionEnvFiles: [absentProductionEnv]
        });
        const text = result.lines.map(formatLine).join('\n');
        expect(text).toContain('FAIL app-dir production path');
        expectNoConnection(text);
    });

    test('refuses NODE_ENV=production from the env file', async () => {
        const { text } = await run(appDir, baseEnv().replace('NODE_ENV=staging', 'NODE_ENV=production'));
        expect(text).toContain('FAIL environment production');
        expectNoConnection(text);
    });

    test('refuses NODE_ENV=production from the process environment', async () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            writeEnv(appDir, baseEnv());
            const result = await executeStagingCheck({
                appDir,
                appDirProvided: true,
                envFile: 'staging.env',
                productionEnvFiles: [absentProductionEnv]
            });
            const text = result.lines.map(formatLine).join('\n');
            expect(text).toContain('FAIL environment production');
            expectNoConnection(text);
        } finally {
            process.env.NODE_ENV = previous;
        }
    });

    test('refuses APP_ENV=production and ENVIRONMENT=production', async () => {
        const app = await run(appDir, baseEnv().replace('APP_ENV=staging', 'APP_ENV=production'));
        expect(app.text).toContain('FAIL environment production');
        expectNoConnection(app.text);
        jest.clearAllMocks();
        const named = await run(appDir, baseEnv().replace('ENVIRONMENT=staging', 'ENVIRONMENT=Production'));
        expect(named.text).toContain('FAIL environment production');
        expectNoConnection(named.text);
    });

    test('refuses a missing or unreadable env file', async () => {
        const missing = await executeStagingCheck({
            appDir,
            appDirProvided: true,
            envFile: 'missing.env',
            processEnv: { NODE_ENV: 'test' },
            productionEnvFiles: [absentProductionEnv]
        });
        const missingText = missing.lines.map(formatLine).join('\n');
        expect(missingText).toContain('FAIL env-file unreadable');
        expectNoConnection(missingText);
        jest.clearAllMocks();
        const unreadable = await executeStagingCheck({
            appDir,
            appDirProvided: true,
            envFile: appDir,
            processEnv: { NODE_ENV: 'test' },
            productionEnvFiles: [absentProductionEnv]
        });
        const unreadableText = unreadable.lines.map(formatLine).join('\n');
        expect(unreadableText).toContain('FAIL env-file unreadable');
        expectNoConnection(unreadableText);
    });

    test('refuses the default production database names without printing the URI', async () => {
        const system = await run(appDir, baseEnv().replace(
            '/staging_readiness?',
            '/vodafone_cash_system?'
        ));
        expect(system.text).toContain('FAIL database denied');
        expect(system.text).not.toContain('vodafone_cash_system');
        expectNoConnection(system.text);
        jest.clearAllMocks();
        const legacy = await run(appDir, baseEnv().replace(
            '/staging_readiness?',
            '/vodafone_cash?'
        ));
        expect(legacy.text).toContain('FAIL database denied');
        expectNoConnection(legacy.text);
    });

    test('refuses a repeated --deny-db name and STAGING_CHECK_DENY_DBS', async () => {
        const denied = await run(appDir, baseEnv(), { denyDb: ['staging_readiness'] });
        expect(denied.text).toContain('FAIL database denied');
        expectNoConnection(denied.text);
        jest.clearAllMocks();
        const listed = await run(appDir, `${baseEnv()}\nSTAGING_CHECK_DENY_DBS=other_db,staging_readiness`);
        expect(listed.text).toContain('FAIL database denied');
        expectNoConnection(listed.text);
    });

    test('refuses when the database name matches the production env file and skips a missing production env', async () => {
        const productionEnv = path.join(appDir, 'production.env');
        fs.writeFileSync(productionEnv, `MONGO_URI=mongodb://owner:${SECRET}@10.9.8.7:27017/private_prod_db?authSource=admin\nSMTP_PASS=do-not-print\n`);
        const matched = await run(appDir, baseEnv().replace('/staging_readiness?', '/private_prod_db?'), {
            productionEnvFiles: [productionEnv]
        });
        expect(matched.text).toContain('FAIL database matches production env');
        expect(matched.text).not.toContain('private_prod_db');
        expect(matched.text).not.toContain('10.9.8.7');
        expect(matched.text).not.toContain('do-not-print');
        expectNoConnection(matched.text);
        jest.clearAllMocks();
        const skipped = await run(appDir, baseEnv(), {
            productionEnvFiles: [path.join(appDir, 'no-such-production.env')]
        });
        expect(skipped.text).not.toContain('FAIL database');
        expect(mongoose.connect).toHaveBeenCalledTimes(1);
        expect(Redis).not.toHaveBeenCalled();
        expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    test('refuses a URI with no explicit database name', async () => {
        const { text } = await run(appDir, baseEnv().replace(
            `MONGO_URI=${SAFE_URI}`,
            'MONGO_URI=mongodb://staging-user:staging-secret-not-real@127.0.0.1:27017/?replicaSet=rs0'
        ));
        expect(text).toContain('FAIL database name missing');
        expectNoConnection(text);
    });

    test('refuses PRODUCTION=true and TENANT or DEPLOY values of production', async () => {
        const flagged = await run(appDir, `${baseEnv()}\nPRODUCTION=true`);
        expect(flagged.text).toContain('FAIL environment marker');
        expectNoConnection(flagged.text);
        jest.clearAllMocks();
        const deploy = await run(appDir, `${baseEnv()}\nDEPLOY_ENV=production`);
        expect(deploy.text).toContain('FAIL environment marker');
        expectNoConnection(deploy.text);
        jest.clearAllMocks();
        const tenant = await run(appDir, `${baseEnv()}\nTENANT_ENV=production`);
        expect(tenant.text).toContain('FAIL environment marker');
        expectNoConnection(tenant.text);
    });
});
