'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

jest.setTimeout(180000);

describe('executor financial mutations on a replica set', () => {
    let replset;
    let uri;

    beforeAll(async () => {
        uri = process.env.EXECUTOR_FINANCIAL_TEST_MONGO_URI;
        if (uri) {
            if (!['127.0.0.1', 'localhost'].includes(new URL(uri).hostname)) {
                throw new Error('Executor financial integration tests require local MongoDB');
            }
            return;
        }
        const { MongoMemoryReplSet } = require('mongodb-memory-server');
        replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
        uri = replset.getUri();
    });

    afterAll(async () => {
        if (replset) await replset.stop();
    });

    test('funding, provider execution, amount edits, and refunds preserve balances', () => {
        const script = path.join(__dirname, '..', 'scripts', 'checkExecutorFinancialMongo.js');
        const result = spawnSync(process.execPath, [script], {
            env: { ...process.env, EXECUTOR_FINANCIAL_TEST_MONGO_URI: uri },
            encoding: 'utf8',
            timeout: 150000,
            windowsHide: true
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"result":"PASS"');
    });

    test('readiness detects a legacy TTL index without changing indexes or financial records', async () => {
        const mongoose = require('mongoose');
        const { inspectExecutorReadiness } = require('../services/executorReadinessService');
        const connection = mongoose.createConnection(uri, {
            dbName: `codex_readiness_${Date.now()}`, autoIndex: false, autoCreate: false
        });
        try {
            await connection.asPromise();
            const transactions = connection.db.collection('transactions');
            const devices = connection.db.collection('trusteddevices');
            await transactions.insertOne({ customId: 'READINESS-FIXTURE', amount: 250, costLYD: 20, status: 'accepted' });
            await devices.insertOne({ expiresAt: new Date(Date.now() + 86400000), fixture: true });
            await devices.createIndex({ expiresAt: 1 }, { name: 'expiresAt_1' });
            const outbox = connection.db.collection('executorcompletionoutboxes');
            await outbox.createIndex({ transactionId: 1 }, { unique: true });
            await outbox.createIndex({ status: 1, availableAt: 1, createdAt: 1 });
            const financialBefore = await transactions.findOne({});
            const deviceBefore = await devices.findOne({});
            const indexesBefore = await devices.indexes();

            const legacy = await inspectExecutorReadiness(connection);
            expect(legacy.ready).toBe(false);
            expect(legacy.checks.find((check) => check.code === 'TRUSTED_DEVICE_TTL').reason)
                .toBe('TTL_INDEX_MISSING_OR_CONFLICTING');
            expect(await devices.indexes()).toEqual(indexesBefore);
            expect(await devices.findOne({})).toEqual(deviceBefore);
            expect(await transactions.findOne({})).toEqual(financialBefore);

            // Modify only the isolated test fixture to exercise the valid-index path.
            await devices.dropIndex('expiresAt_1');
            await devices.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
            const validIndexes = await devices.indexes();
            const ready = await inspectExecutorReadiness(connection);
            expect(ready.ready).toBe(true);
            expect(await devices.indexes()).toEqual(validIndexes);
            expect(await transactions.findOne({})).toEqual(financialBefore);

            const probeUri = new URL(uri);
            probeUri.pathname = `/${connection.name}`;
            const result = spawnSync(process.execPath, [
                path.join(__dirname, '..', 'scripts', 'checkExecutorReadiness.js'),
                path.join(__dirname, '..', 'test-artifacts', 'readiness-no-env')
            ], {
                env: { ...process.env, MONGO_URI: probeUri.toString() },
                encoding: 'utf8', timeout: 30000, windowsHide: true
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout).ready).toBe(true);
            expect(await devices.indexes()).toEqual(validIndexes);
            expect(await transactions.findOne({})).toEqual(financialBefore);
        } finally {
            await connection.close();
        }
    });
});
