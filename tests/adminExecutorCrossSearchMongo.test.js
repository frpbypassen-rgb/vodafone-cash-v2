'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const TransactionSchema = require('../models/Transaction').schema;
const ExecutorSchema = require('../models/ExecutorGroup').schema;
const { loadExecutorHistory, loadOtherExecutorMatches } = require('../services/adminExecutorDetailService');

let mongo, connection, Transaction, ExecutorGroup;
beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    connection = await mongoose.createConnection(mongo.getUri(), { dbName: 'executor_cross_search_test' }).asPromise();
    ExecutorGroup = connection.model('ExecutorGroup', ExecutorSchema);
    Transaction = connection.model('Transaction', TransactionSchema);
}, 60000);
afterAll(async () => { if (connection) await connection.close(); if (mongo) await mongo.stop(); });

test('real Mongo lookup keeps this executor local and identifies the matching operation at another executor', async () => {
    const tenantA = new mongoose.Types.ObjectId();
    const tenantB = new mongoose.Types.ObjectId();
    const current = await ExecutorGroup.create({ name: 'المنفذ الحالي', tenantId: tenantA });
    const other = await ExecutorGroup.create({ name: 'المنفذ الآخر', tenantId: tenantA });
    const otherTenant = await ExecutorGroup.create({ name: 'منفذ خارج النطاق', tenantId: tenantB });
    await Transaction.collection.insertMany([
        { customId: 'ATT-2611-28591', tenantId: tenantA, executorGroupId: current._id, status: 'completed', amount: 100, vodafoneNumber: '0912345678', createdAt: new Date('2026-11-19T12:00:00Z') },
        { customId: 'ATT-2611-28592', tenantId: tenantA, executorGroupId: other._id, status: 'completed', amount: 970, vodafoneNumber: '0912345678', createdAt: new Date('2026-11-19T13:00:00Z') },
        { customId: 'ATT-2611-28593', tenantId: tenantB, executorGroupId: otherTenant._id, status: 'completed', amount: 50, vodafoneNumber: '0912345678', createdAt: new Date('2026-11-19T14:00:00Z') },
        { customId: 'ATT-2611-BANK1', tenantId: tenantA, executorGroupId: other._id, status: 'completed', amount: 44, serviceDetails: { clientPhone: '0940719000' }, createdAt: new Date('2026-11-19T14:20:00Z') },
        { customId: 'SETTLE-OWN', tenantId: tenantA, executorGroupId: current._id, status: 'deposit_pending', amount: 10, vodafoneNumber: '0912345678', createdAt: new Date('2026-11-19T14:30:00Z') },
        { customId: 'SETTLE-28592', tenantId: tenantA, executorGroupId: other._id, status: 'deposit', amount: 970, vodafoneNumber: '0912345678', createdAt: new Date('2026-11-19T15:00:00Z') }
    ]);
    const scope = { tenantId: tenantA };
    const ownHistory = await loadExecutorHistory(Transaction, current, { tab: 'operations', q: '0912345678' });
    expect(ownHistory.rows.map(row => row.customId)).toEqual(['ATT-2611-28591']);
    const elsewhere = await loadOtherExecutorMatches(Transaction, current, { tab: 'operations', q: '0912345678' }, scope);
    expect(elsewhere.map(row => row.customId)).toEqual(['ATT-2611-28592']);
    expect(elsewhere[0].executorGroupId.name).toBe('المنفذ الآخر');
    const byBankPhone = await loadOtherExecutorMatches(Transaction, current, { tab: 'operations', q: '0940719000' }, scope);
    expect(byBankPhone.map(row => row.customId)).toEqual(['ATT-2611-BANK1']);
    const deposits = await loadExecutorHistory(Transaction, other, { tab: 'deposits' });
    expect(deposits.rows.map(row => row.customId)).toEqual(['SETTLE-28592']);
    const ownDeposits = await loadExecutorHistory(Transaction, current, { tab: 'deposits' });
    expect(ownDeposits.rows.map(row => row.customId)).toEqual(['SETTLE-OWN']);
});
