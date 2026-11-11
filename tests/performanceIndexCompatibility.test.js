'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Transaction = require('../models/Transaction');
const { ensurePerformanceIndexes, clientPortalIndexes } = require('../services/performanceIndexService');
let mongo;
jest.setTimeout(60000);
beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Transaction.init();
});
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
test('schema-created legacy index names do not prevent creating the remaining performance indexes', async () => {
    expect(await ensurePerformanceIndexes()).toBe(true);
    expect(await ensurePerformanceIndexes()).toBe(true);
    const existing = await Transaction.collection.listIndexes().toArray();
    for (const expected of clientPortalIndexes) {
        expect(existing.some(index => JSON.stringify(index.key) === JSON.stringify(expected.key))).toBe(true);
    }
    expect(existing.some(index => index.name === 'transferCooldownExact_v1')).toBe(true);
});
