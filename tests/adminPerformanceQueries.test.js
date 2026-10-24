'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { completedTodayMatch } = require('../services/dashboardIntelligenceService');
const { loadCentralLedgerOverview, successfulOpsPeriodBounds } = require('../services/centralLedgerOverviewService');

describe('admin read query financial parity', () => {
    let server;
    let connection;
    let collection;
    beforeAll(async () => {
        server = await MongoMemoryServer.create();
        connection = await mongoose.createConnection(server.getUri(), { dbName: 'admin_performance_test' }).asPromise();
        collection = connection.db.collection('transactions');
    }, 60000);
    afterAll(async () => {
        if (connection) await connection.close();
        if (server) await server.stop();
    });
    beforeEach(async () => { await collection.deleteMany({}); });

    test('early date filter equals the old completion-date calculation across tenants and boundary cases', async () => {
        const start = new Date('2026-10-23T22:00:00Z');
        const end = new Date('2026-10-24T12:00:00Z');
        const old = new Date('2025-01-01T00:00:00Z');
        const base = { tenantId: 'a', status: 'completed', amount: 120, costLYD: 20 };
        await collection.insertMany([
            { ...base, key: 'old-created-new-completed', createdAt: old, completedAt: start },
            { ...base, key: 'end-inclusive', createdAt: start, completedAt: end },
            { ...base, key: 'missing-completion', createdAt: start },
            { ...base, key: 'null-completion', createdAt: start, completedAt: null },
            { ...base, key: 'past-completion', createdAt: start, completedAt: old },
            { ...base, key: 'future-completion', createdAt: start, completedAt: new Date(end.getTime() + 1) },
            { ...base, key: 'future-created', createdAt: new Date(end.getTime() + 1), completedAt: end },
            { ...base, key: 'other-tenant', createdAt: start, completedAt: end, tenantId: 'b' },
            { ...base, key: 'cancelled', createdAt: start, completedAt: end, status: 'cancelled_by_admin' },
            ...Array.from({ length: 500 }, (_, i) => ({ ...base, key: `history-${i}`, createdAt: old, completedAt: old }))
        ]);
        const scope = { tenantId: 'a', $and: [{ amount: { $gt: 0 } }] };
        const legacy = await collection.aggregate([
            { $match: { ...scope, status: 'completed', createdAt: { $lte: end } } },
            { $set: { effectiveDate: { $ifNull: ['$completedAt', '$createdAt'] } } },
            { $match: { effectiveDate: { $gte: start, $lte: end } } },
            { $project: { effectiveDate: 0 } }
        ]).toArray();
        const optimized = await collection.find(completedTodayMatch(scope, start, end)).toArray();
        const ids = rows => rows.map(row => row.key).sort();
        expect(ids(optimized)).toEqual(ids(legacy));
        expect(ids(optimized)).toEqual(['end-inclusive', 'missing-completion', 'null-completion', 'old-created-new-completed']);
        expect(optimized.reduce((sum, row) => sum + row.costLYD, 0)).toBe(80);
    });

    test('ledger prefilter preserves the rolling week across month boundaries and excludes duplicate balance-transfer credits', async () => {
        const now = new Date('2026-10-02T12:00:00+02:00');
        const bounds = successfulOpsPeriodBounds(now);
        await collection.insertMany([
            { status: 'completed', createdAt: bounds.week.$gte, amount: 100, costLYD: 20, transferType: 'vodafone' },
            { status: 'completed', createdAt: bounds.month.$gte, amount: 200, costLYD: 40, transferType: 'bank_account' },
            { status: 'completed', createdAt: bounds.today.$gte, amount: 300, costLYD: 60, transferType: 'vodafone' },
            { status: 'completed', createdAt: bounds.today.$gte, amount: 900, costLYD: 180, transferType: 'balance_transfer', customId: 'MOVE-C' },
            { status: 'deposit', createdAt: bounds.today.$gte, amount: 800 },
            { status: 'cancelled_by_admin', createdAt: bounds.today.$gte, amount: 700 },
            { status: 'completed', createdAt: new Date('2025-01-01'), amount: 999, costLYD: 199 }
        ]);
        const Transaction = { aggregate: pipeline => collection.aggregate(pipeline).toArray() };
        const ClientCompany = { find: () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }) };
        const ExecutorGroup = { find: () => ({ select: () => ({ lean: async () => [] }) }) };
        const before = await collection.find().toArray();
        const result = await loadCentralLedgerOverview({ Transaction, ClientCompany, ExecutorGroup, source: {}, now });
        expect(result.periodStats.today).toEqual({ count: 1, amountEGP: 300, costLYD: 60 });
        expect(result.periodStats.week).toEqual({ count: 3, amountEGP: 600, costLYD: 120 });
        expect(result.periodStats.month).toEqual({ count: 2, amountEGP: 500, costLYD: 100 });
        expect(await collection.find().toArray()).toEqual(before);
    });
});
