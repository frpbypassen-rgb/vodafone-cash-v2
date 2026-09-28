'use strict';

jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../services/whatsappReceiptDeliveryService', () => ({
    sendCompletedTransactionReceipt: jest.fn(), sendSplitPartReceipt: jest.fn()
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const BulkJobLock = require('../models/BulkJobLock');
const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const { retryFailedDeliveries } = require('../services/whatsappFailedDeliveryRetryService');
const { logAction } = require('../services/auditService');

jest.setTimeout(180000);
const KEY = 'whatsapp-monitor-failed-retry';
let replicaSet;

beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replicaSet.getUri(), { dbName: 'isolated_whatsapp_lock_test', autoIndex: false, autoCreate: false });
    await BulkJobLock.createCollection();
    await WhatsAppDelivery.createCollection();
});
beforeEach(async () => {
    jest.clearAllMocks();
    await BulkJobLock.collection.deleteMany({});
    logAction.mockResolvedValue(undefined);
});
afterAll(async () => {
    await mongoose.disconnect();
    if (replicaSet) await replicaSet.stop();
});

test('two batch workers are mutually exclusive with only the mandatory _id index', async () => {
    expect((await BulkJobLock.collection.indexes()).map((index) => index.name)).toEqual(['_id_']);
    const outcomes = await Promise.all([
        retryFailedDeliveries({ throttleMs: 0 }), retryFailedDeliveries({ throttleMs: 0 })
    ]);
    expect(outcomes.map((item) => item.code).sort()).toEqual(['BULK_RETRY_BUSY', 'BULK_RETRY_COMPLETED']);
    expect(await BulkJobLock.countDocuments({})).toBe(0);
});

test('an active legacy ObjectId lock blocks a new worker', async () => {
    await BulkJobLock.collection.insertOne({
        key: KEY, ownerId: 'legacy', expiresAt: new Date(Date.now() + 60000)
    });
    expect((await retryFailedDeliveries({ throttleMs: 0 })).code).toBe('BULK_RETRY_BUSY');
    expect(await BulkJobLock.collection.countDocuments({ ownerId: 'legacy' })).toBe(1);
});

test('expired legacy locks are replaced without requiring a new unique index', async () => {
    await BulkJobLock.collection.createIndex({ key: 1 }, { unique: true });
    try {
        await BulkJobLock.collection.insertOne({ key: KEY, ownerId: 'expired', expiresAt: new Date(0) });
        expect((await retryFailedDeliveries({ throttleMs: 0 })).code).toBe('BULK_RETRY_COMPLETED');
        expect(await BulkJobLock.collection.countDocuments({})).toBe(0);
    } finally {
        await BulkJobLock.collection.dropIndex('key_1');
    }
});
