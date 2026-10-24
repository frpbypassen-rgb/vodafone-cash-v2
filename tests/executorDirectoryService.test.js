'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const ExecutorBalancePool = require('../models/ExecutorBalancePool');
const { syncBotBalance } = require('../utils/helpers');
const { loadExecutorDirectory } = require('../services/executorDirectoryService');
const { snapshotServiceLedgers, allocatedFromRows } = require('../utils/executorServiceLedger');

describe('executor directory read-only ledger parity', () => {
    let server;
    const id = () => new mongoose.Types.ObjectId();
    beforeAll(async () => {
        server = await MongoMemoryServer.create();
        await mongoose.connect(server.getUri(), { dbName: 'executor_directory_test' });
    }, 60000);
    afterAll(async () => { await mongoose.disconnect(); if (server) await server.stop(); });
    beforeEach(async () => {
        await Promise.all([ExecutorGroup, Transaction, Employee, ExecutorBalancePool].map(model => model.deleteMany({})));
    });
    const load = async () => loadExecutorDirectory({
        groups: await ExecutorGroup.find({ status: { $ne: 'archived' } }).lean(),
        archivedGroups: await ExecutorGroup.find({ status: 'archived' }).lean(),
        Transaction, Employee, ExecutorBalancePool
    });

    test('matches reconciliation for services, signed deductions, manager roles and pool membership without writing', async () => {
        const groups = await ExecutorGroup.create([
            { name: 'ordinary', serviceKeys: ['vodafone', 'bank_account', 'postal'] },
            { name: 'manager group', isManagerGroup: true, isManagerBot: true, serviceKey: 'bank_account' },
            { name: 'manager bot only', isManagerBot: true },
            { name: 'manager group only', isManagerGroup: true },
            { name: 'empty' }
        ]);
        const txs = [];
        for (const group of groups.slice(0, 4)) {
            for (const [status, amount, transferType, canonicalServiceKey] of [
                ['deposit', 1000, 'vodafone'], ['completed', 120, 'vodafone'],
                ['deposit', 600, 'bank_account'], ['completed', 90, 'cash', 'bank_account'],
                ['deduction', -20, 'bank_account'], ['deduction', 30, 'bank_account'],
                ['completed', 5, 'post_card'], ['deposit', 40, 'post_account'],
                ['completed', 4, 'unknown'], ['completed', 3, ' CASH '],
                ['completed', 999, 'external_balance'], ['deposit', 999, 'external_balance'],
                ['pending', 700, 'vodafone'], ['cancelled_by_admin', 800, 'vodafone']
            ]) txs.push({ executorGroupId: group._id, status, amount, transferType, canonicalServiceKey });
            txs.push({ executorGroupId: id(), managerGroupId: group._id, status: 'completed', amount: 50, transferType: 'bank_account' });
            txs.push({ executorGroupId: group._id, managerGroupId: group._id, status: 'completed', amount: 25, transferType: 'vodafone' });
            const pool = id();
            await ExecutorBalancePool.collection.insertMany([
                { _id: pool, groupId: group._id, balance: 100 },
                { groupId: group._id, balance: 999, archivedAt: new Date() }
            ]);
            await Employee.collection.insertMany([
                { groupId: group._id, role: 'external', balance: 100, balancePoolId: pool },
                { groupId: group._id, role: 'external', balance: 15 },
                { groupId: group._id, role: 'external', balance: 10, balancePoolId: id() },
                { groupId: group._id, role: 'external', balance: 999, archivedAt: new Date() },
                { groupId: group._id, role: 'operator', balance: 999 }
            ].map(row => ({ ...row, webUsername: String(id()) })));
        }
        await Transaction.collection.insertMany(txs.map(row => ({ ...row, customId: String(id()) })));
        const models = [ExecutorGroup, Transaction, Employee, ExecutorBalancePool];
        const before = await Promise.all(models.map(model => model.find().lean()));
        const result = await load();
        expect(await Promise.all(models.map(model => model.find().lean()))).toEqual(before);
        for (const group of groups) {
            const card = result.bots.find(bot => String(bot._id) === String(group._id));
            const legacyBalance = await syncBotBalance(group._id, { session: null });
            const fresh = await ExecutorGroup.findById(group._id).lean();
            const active = { archivedAt: null, groupId: group._id };
            const allocated = allocatedFromRows({
                pools: await ExecutorBalancePool.find(active).lean(),
                employees: await Employee.find({ ...active, role: 'external' }).lean()
            });
            expect(card.balance).toBeCloseTo(legacyBalance, 8);
            const byService = rows => [...rows].sort((a, b) => a.serviceKey.localeCompare(b.serviceKey));
            expect(byService(card.serviceBalances)).toEqual(byService(snapshotServiceLedgers({ group: fresh, allocatedBalance: allocated }).byService));
            const count = await Transaction.countDocuments({
                [group.isManagerBot ? 'managerGroupId' : 'executorGroupId']: group._id, status: 'completed'
            });
            expect(card.txCount).toBe(count);
        }
    });

    test('archived counts preserve the union of executor and manager references and saved archive values', async () => {
        const [a, b] = await ExecutorGroup.create([
            { name: 'legacy archive', status: 'archived', balance: 8 },
            { name: 'saved archive', status: 'archived', archiveTransactionCount: 77, archiveBalance: 0 }
        ]);
        await Transaction.collection.insertMany([
            { executorGroupId: a._id, managerGroupId: a._id, status: 'completed' },
            { executorGroupId: a._id, status: 'pending' },
            { executorGroupId: b._id, managerGroupId: a._id, status: 'deposit' },
            { executorGroupId: id(), status: 'completed' }
        ].map(row => ({ ...row, customId: String(id()) })));
        const result = await load();
        expect(result.archivedBots.find(bot => bot.name === a.name)).toMatchObject({ txCount: 3, balance: 8 });
        expect(result.archivedBots.find(bot => bot.name === b.name)).toMatchObject({ txCount: 77, balance: 0 });
    });

    test('API cards keep zero, missing and failed-check snapshots distinct without provider requests', async () => {
        const checkedAt = new Date('2026-10-24T00:00:00Z');
        await ExecutorGroup.create([
            { name: 'zero', isApiBot: true, lastApiServiceCredit: 0, lastApiTestAt: checkedAt, lastApiTestStatus: 'success' },
            { name: 'missing', isApiBot: true },
            { name: 'failed', isApiBot: true, lastApiServiceCredit: 123, lastApiBalanceCheckStatus: 'check_failed' }
        ]);
        const result = await load();
        expect(result.bots.find(bot => bot.name === 'zero')).toMatchObject({ liveApiServiceCredit: 0, liveApiBalanceCheckedAt: checkedAt });
        expect(result.bots.find(bot => bot.name === 'missing').liveApiServiceCredit).toBeNull();
        expect(result.bots.find(bot => bot.name === 'failed')).toMatchObject({ liveApiServiceCredit: 123, liveApiBalanceError: expect.any(String) });
    });

    test('query count stays fixed across a large directory; no per-card finds or reconciliation', async () => {
        const aggregate = jest.spyOn(Transaction, 'aggregate');
        const poolFind = jest.spyOn(ExecutorBalancePool, 'find');
        const employeeFind = jest.spyOn(Employee, 'find');
        try {
            const groups = Array.from({ length: 100 }, (_, i) => ({
                _id: id(), name: `executor-${i}`, isManagerGroup: true, isManagerBot: true, isApiBot: true
            }));
            const result = await loadExecutorDirectory({ groups, archivedGroups: [], Transaction, Employee, ExecutorBalancePool });
            expect(result.bots).toHaveLength(100);
            expect(aggregate).toHaveBeenCalledTimes(2);
            expect(poolFind).toHaveBeenCalledTimes(1);
            expect(employeeFind).toHaveBeenCalledTimes(1);
        } finally {
            aggregate.mockRestore(); poolFind.mockRestore(); employeeFind.mockRestore();
        }
    });
});
