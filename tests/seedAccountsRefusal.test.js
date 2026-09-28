'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluateSeedAccounts } = require('../seed-accounts');
const {
    assertExplicitNonProductionMongoUri,
    assertLocalSeedTarget
} = require('../scripts/lib/productionDatabaseGuard');
const { assertFactoryResetAllowed } = require('../scripts/factoryReset');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const runSeedScript = (env) => spawnSync(process.execPath, ['seed-accounts.js'], {
    cwd: root,
    env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        ...env
    },
    encoding: 'utf8'
});

describe('seed-accounts production refusal', () => {
    test('refuses NODE_ENV=production before any database work', () => {
        expect(() => evaluateSeedAccounts({
            NODE_ENV: 'production',
            MONGO_URI: 'mongodb://127.0.0.1:27017/local_demo'
        })).toThrow(/NODE_ENV/);
    });

    test.each([
        'mongodb://127.0.0.1:27017/vodafone_cash_system',
        'mongodb://127.0.0.1:27017/vodafone_cash?replicaSet=rs0',
        'mongodb+srv://user:secret@cluster.example.net/vodafone_cash_system'
    ])('refuses known production database name in %s', (mongoUri) => {
        expect(() => evaluateSeedAccounts({
            NODE_ENV: 'development',
            MONGO_URI: mongoUri
        })).toThrow(/production database/);
    });

    test('requires an explicit non-production MONGO_URI and then stays disabled', () => {
        expect(() => evaluateSeedAccounts({ NODE_ENV: 'development' })).toThrow(/MONGO_URI is required/);
        expect(() => evaluateSeedAccounts({
            NODE_ENV: 'development',
            MONGO_URI: 'mongodb://127.0.0.1:27017'
        })).toThrow(/explicit database name/);
        expect(() => evaluateSeedAccounts({
            NODE_ENV: 'development',
            MONGO_URI: 'mongodb://127.0.0.1:27017/local_demo'
        })).toThrow(/disabled/);
    });

    test('the script process refuses production and does not print a connection string', () => {
        const productionEnv = runSeedScript({
            NODE_ENV: 'production',
            MONGO_URI: 'mongodb://127.0.0.1:27017/local_demo'
        });
        const productionDatabase = runSeedScript({
            NODE_ENV: 'development',
            MONGO_URI: 'mongodb://127.0.0.1:27017/vodafone_cash_system'
        });

        expect(productionEnv.status).not.toBe(0);
        expect(productionEnv.stderr).toMatch(/NODE_ENV/);
        expect(productionDatabase.status).not.toBe(0);
        expect(productionDatabase.stderr).toMatch(/production database/);
        expect(`${productionEnv.stdout}${productionEnv.stderr}${productionDatabase.stdout}${productionDatabase.stderr}`)
            .not.toMatch(/mongodb(?:\+srv)?:\/\//);
    });

    test('seed-accounts.js has no database client and no hard-coded database name', () => {
        const source = read('seed-accounts.js');
        expect(source).not.toMatch(/mongoose/);
        expect(source).not.toMatch(/bcrypt/);
        expect(source).not.toMatch(/vodafone_cash/);
    });
});

describe('local seed and factory reset guards', () => {
    test('local seed scripts refuse production names and NODE_ENV', () => {
        expect(() => assertLocalSeedTarget({
            NODE_ENV: 'production',
            MONGO_URI: 'mongodb://127.0.0.1:27017/local_demo'
        })).toThrow(/production/);
        expect(() => assertExplicitNonProductionMongoUri({
            APP_ENV: 'production',
            MONGO_URI: 'mongodb://127.0.0.1:27017/local_demo'
        })).toThrow(/production/);
        expect(() => assertLocalSeedTarget({
            NODE_ENV: 'development',
            MONGO_URI: 'mongodb://127.0.0.1:27017/vodafone_cash'
        })).toThrow(/production database/);
        expect(assertLocalSeedTarget({
            NODE_ENV: 'development',
            MONGO_URI: 'mongodb://127.0.0.1:27017/local_demo'
        }).databaseName).toBe('local_demo');
    });

    test('factory reset refuses production before a password is required', () => {
        expect(() => assertFactoryResetAllowed({
            NODE_ENV: 'production',
            MONGO_URI: 'mongodb://127.0.0.1:27017/local_demo'
        })).toThrow(/production/);
        expect(() => assertFactoryResetAllowed({
            NODE_ENV: 'development',
            MONGO_URI: 'mongodb://127.0.0.1:27017/vodafone_cash_system',
            PANEL_USER: 'owner',
            PANEL_PASS: 'not-used-in-this-assertion'
        })).toThrow(/production database/);
    });

    test('seed scripts no longer embed the removed local passwords or the production database default', () => {
        const localSeeds = [
            'scripts/seedLocalMobileDemo.js',
            'scripts/seedLocalExecutorAccounts.js',
            'scripts/seedLocalExecutorTask.js'
        ].map(read).join('\n');
        expect(localSeeds).toMatch(/assertLocalSeedTarget/);
        expect(localSeeds).not.toMatch(/vodafone_cash_system/);
        expect(localSeeds).not.toMatch(/password:\s*'[^']+'/);
        expect(localSeeds).not.toMatch(/const password = '[^']+'/);
        expect(read('scripts/factoryReset.js')).not.toMatch(/PANEL_PASS \|\|/);
        expect(read('scripts/factoryReset.js')).not.toMatch(/vodafone_cash_system/);
        expect(read('config/mockDatabase.js')).not.toMatch(/zaynApiPass = await bcrypt\.hash\(/);
    });
});
