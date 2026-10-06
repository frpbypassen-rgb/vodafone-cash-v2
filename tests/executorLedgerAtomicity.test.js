'use strict';

jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(true) }));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));
jest.mock('../services/lockService', () => ({ acquireLock: jest.fn().mockResolvedValue({}), releaseLock: jest.fn().mockResolvedValue() }));
jest.mock('../utils/manualExecutorReceipt', () => ({
    ...jest.requireActual('../utils/manualExecutorReceipt'),
    generateManualExecutorReceiptBase64: jest.fn().mockResolvedValue(
        `data:image/png;base64,${jest.requireActual('fs').readFileSync(jest.requireActual('path').join(__dirname, '..', 'public', 'images', 'instapay_logo.png')).toString('base64')}`
    )
}));
jest.mock('../services/manualExecutorReceiptReferenceService', () => ({
    reserveManualExecutorReceiptReference: jest.fn().mockResolvedValue({ reference: '999001' })
}));

const crypto = require('crypto');
const fs = require('fs');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const ExecutorBalancePool = require('../models/ExecutorBalancePool');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');
const pools = require('../services/executorBalancePoolService');
const { syncBotBalance } = require('../utils/helpers');
const { resolveDepositTicket } = require('../services/executorDepositRequestService');
const { completeExecutorTask } = require('../services/executorCompletionService');
const { loadPortalLiveTasks } = require('../services/executorLiveTasksService');

jest.setTimeout(120000);

describe('executor ledger rollback and reconciliation on local Mongo', () => {
    let replset;
    let group;
    let employee;
    let manager;
    const oldRequired = process.env.MONGO_TRANSACTIONS_REQUIRED;

    beforeAll(async () => {
        process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';
        replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
        await mongoose.connect(replset.getUri(), {
            dbName: `codex_executor_atomic_${crypto.randomBytes(6).toString('hex')}`,
            autoIndex: false, autoCreate: false
        });
        for (const Model of [Employee, ExecutorGroup, ExecutorBalancePool, Transaction, SupportTicket, Notification]) {
            await Model.createCollection();
        }
    });

    afterAll(async () => {
        jest.restoreAllMocks();
        await mongoose.disconnect();
        if (replset) await replset.stop();
        if (oldRequired === undefined) delete process.env.MONGO_TRANSACTIONS_REQUIRED;
        else process.env.MONGO_TRANSACTIONS_REQUIRED = oldRequired;
    });

    beforeEach(async () => {
        jest.restoreAllMocks();
        for (const Model of [Employee, ExecutorGroup, ExecutorBalancePool, Transaction, SupportTicket, Notification]) {
            await Model.deleteMany({});
        }
        group = await ExecutorGroup.create({ name: 'Local ledger fixture', balance: 1000, serviceBalances: { vodafone: 1000 } });
        manager = { _id: new mongoose.Types.ObjectId(), role: 'manager', groupId: group._id };
        employee = await Employee.create({ name: 'Local external', role: 'external', status: 'active',
            groupId: group._id, webUsername: 'ledger-fixture@example.test', webPassword: '$2b$12$fixture' });
        await Transaction.create({ customId: 'LOCAL-OPENING', amount: 1000, status: 'deposit', executorGroupId: group._id });
    });

    const fund = (amount = 200, requestId = 'local-ledger-funding-001') => pools.fundExternalExecutor({
        manager, employeeId: String(employee._id), type: 'deposit', amount, requestId
    });
    const total = async () => (await pools.snapshotCompanyBalances(group._id)).totalBalance;
    const pendingDeposit = async () => {
        const tx = await Transaction.create({ customId: 'LOCAL-DEPOSIT', amount: 200, status: 'deposit_pending',
            executorGroupId: group._id });
        const ticket = await SupportTicket.create({ name: 'Local deposit fixture', entityType: 'executor_group',
            entityId: group._id, metadata: { type: 'executor_deposit', depositRequest: {
                transactionId: String(tx._id), customId: tx.customId, amount: tx.amount, status: 'pending'
            } } });
        tx.depositRequest.supportTicketId = ticket._id;
        await tx.save();
        return { tx, ticket };
    };
    const review = (ticket) => resolveDepositTicket({ ticketId: String(ticket._id),
        admin: { id: String(manager._id), name: 'Local reviewer' }, approved: true });

    test('reconciliation retains allocated credit and is repeatable without inflation', async () => {
        await fund();
        await syncBotBalance(group._id);
        await syncBotBalance(group._id);
        expect((await ExecutorGroup.findById(group._id)).balance).toBe(800);
        expect((await Employee.findById(employee._id)).balance).toBe(200);
        expect(await total()).toBe(1000);
    });

    test('failed pool credit rolls back membership, solo debit and newly created pool', async () => {
        await fund();
        jest.spyOn(ExecutorBalancePool, 'findByIdAndUpdate').mockRejectedValueOnce(new Error('INJECTED_POOL_CREDIT_FAILURE'));
        await expect(pools.createPool({ manager, name: 'Local pool', memberIds: [employee._id] }))
            .rejects.toThrow('INJECTED_POOL_CREDIT_FAILURE');
        const saved = await Employee.findById(employee._id);
        expect(saved.balance).toBe(200);
        expect(saved.balancePoolId).toBeNull();
        expect(await ExecutorBalancePool.countDocuments({})).toBe(0);
        expect(await total()).toBe(1000);
    });

    test('failed last-member credit rolls back the pool debit', async () => {
        await fund();
        const pool = await pools.createPool({ manager, name: 'Local pool', memberIds: [employee._id] });
        const save = Employee.prototype.save;
        jest.spyOn(Employee.prototype, 'save').mockImplementation(function (...args) {
            if (String(this._id) === String(employee._id)) throw new Error('INJECTED_SOLO_CREDIT_FAILURE');
            return save.apply(this, args);
        });
        await expect(pools.detachMember({ manager, poolId: pool.id, employeeId: employee._id }))
            .rejects.toThrow('INJECTED_SOLO_CREDIT_FAILURE');
        expect((await ExecutorBalancePool.findById(pool.id)).balance).toBe(200);
        expect(String((await Employee.findById(employee._id)).balancePoolId)).toBe(pool.id);
        expect(await total()).toBe(1000);
    });

    test('concurrent funding and detach preserve the company total and one credit location', async () => {
        await fund();
        const pool = await pools.createPool({ manager, name: 'Local pool', memberIds: [employee._id] });
        const outcomes = await Promise.allSettled([
            pools.detachMember({ manager, poolId: pool.id, employeeId: employee._id }),
            fund(100, 'local-ledger-funding-002')
        ]);
        expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
        expect(await total()).toBe(1000);
        const saved = await Employee.findById(employee._id);
        const savedPool = await ExecutorBalancePool.findById(pool.id);
        if (!saved.balancePoolId) expect(savedPool.balance).toBe(0);
        else expect(saved.balance).toBe(0);
    });

    test('ticket save failure rolls back deposit acceptance and company credit', async () => {
        const { tx, ticket } = await pendingDeposit();
        jest.spyOn(SupportTicket.prototype, 'save').mockRejectedValueOnce(new Error('INJECTED_TICKET_FAILURE'));
        await expect(review(ticket)).rejects.toThrow('INJECTED_TICKET_FAILURE');
        expect((await Transaction.findById(tx._id)).status).toBe('deposit_pending');
        expect((await SupportTicket.findById(ticket._id)).status).toBe('open');
        expect(await total()).toBe(1000);
    });

    test('balance save failure rolls back both accepted deposit and resolved ticket', async () => {
        const { tx, ticket } = await pendingDeposit();
        jest.spyOn(ExecutorGroup.prototype, 'save').mockRejectedValueOnce(new Error('INJECTED_RECONCILIATION_FAILURE'));
        await expect(review(ticket)).rejects.toThrow('INJECTED_RECONCILIATION_FAILURE');
        expect((await Transaction.findById(tx._id)).status).toBe('deposit_pending');
        expect((await SupportTicket.findById(ticket._id)).status).toBe('open');
        expect(await total()).toBe(1000);
    });

    test('successful review keeps allocation and credits the deposit only once', async () => {
        await fund();
        const { ticket } = await pendingDeposit();
        await review(ticket);
        expect(await total()).toBe(1200);
        expect((await ExecutorGroup.findById(group._id)).balance).toBe(1000);
        expect((await SupportTicket.findById(ticket._id)).metadata.depositRequest.status).toBe('approved');
        await expect(review(ticket)).rejects.toMatchObject({ status: 409 });
        expect(await total()).toBe(1200);
    });

    test('manual completion rolls back status when balance persistence fails', async () => {
        const task = await Transaction.create({ customId: 'LOCAL-COMPLETE', amount: 100, costLYD: 20,
            status: 'accepted', executorGroupId: group._id, operatorId: String(employee._id) });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
        jest.spyOn(ExecutorGroup.prototype, 'save').mockRejectedValueOnce(new Error('INJECTED_COMPLETION_BALANCE_FAILURE'));
        const executor = await Employee.findById(employee._id).populate('groupId');
        await expect(completeExecutorTask({ transactionId: task._id, executorId: employee._id, executor,
            body: { executionNumber: '01108172258' } })).rejects.toThrow('INJECTED_COMPLETION_BALANCE_FAILURE');
        expect((await Transaction.findById(task._id)).status).toBe('accepted');
        expect((await ExecutorGroup.findById(group._id)).balance).toBe(1000);
    });

    test('funding followed by completion preserves ledger total and pricing fields', async () => {
        await fund();
        const task = await Transaction.create({ customId: 'LOCAL-COMPLETE-OK', status: 'accepted',
            amount: 100, costLYD: 20, executorGroupId: group._id, operatorId: String(employee._id) });
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
        const executor = await Employee.findById(employee._id).populate('groupId');
        await completeExecutorTask({ transactionId: task._id, executorId: employee._id, executor,
            body: { executionNumber: '01108172258' } });
        const stored = await Transaction.findById(task._id);
        expect(stored.status).toBe('completed');
        expect(stored.amount).toBe(100);
        expect(stored.costLYD).toBe(20);
        expect(await total()).toBe(900);
        expect((await ExecutorGroup.findById(group._id)).balance).toBe(700);
        expect((await Employee.findById(employee._id)).balance).toBe(200);
    });

    test('company completed-today aggregation matches actual ObjectId groups only', async () => {
        const now = new Date();
        await Transaction.create({ customId: 'LOCAL-TODAY', status: 'completed', amount: 125,
            executorGroupId: group._id, operatorId: String(employee._id), completedAt: now });
        await Transaction.create({ customId: 'FOREIGN-TODAY', status: 'completed', amount: 9000,
            executorGroupId: new mongoose.Types.ObjectId(), completedAt: now });
        const payload = await loadPortalLiveTasks({ emp: { ...manager, groupId: group._id }, now });
        expect(payload.completedTodaySummary).toMatchObject({ count: 1, amount: 125 });
        expect(payload.completedToday).toHaveLength(1);
        expect(payload.completedToday[0].customId).toBe('LOCAL-TODAY');
    });
});
