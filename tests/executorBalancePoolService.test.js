'use strict';

jest.mock('../models/Employee', () => {
    const { makeCollectionModel } = require('./helpers/executorPoolStore');
    return makeCollectionModel('employees');
});
jest.mock('../models/ExecutorBalancePool', () => {
    const { makeCollectionModel } = require('./helpers/executorPoolStore');
    return makeCollectionModel('pools');
});
jest.mock('../models/ExecutorGroup', () => ({
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn()
}));
jest.mock('../models/Transaction', () => ({ create: jest.fn() }));
jest.mock('../models/Notification', () => ({ create: jest.fn() }));

const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Notification = require('../models/Notification');
const { applyInc, matchesFilter, resetStore, store } = require('./helpers/executorPoolStore');
const {
    attachMembers,
    createPool,
    detachMember,
    fundExternalExecutor,
    listExternalBalanceWorkspace,
    snapshotCompanyBalances,
    snapshotFromParts
} = require('../services/executorBalancePoolService');
const { depositAlertQuery } = require('../services/executorLiveTasksService');

const manager = { _id: 'manager-1', role: 'manager', groupId: 'group-1', name: 'مدير الشركة' };

const seedEmployee = (data) => {
    store.employees.set(String(data._id), {
        status: 'active',
        archivedAt: null,
        balance: 0,
        balancePoolId: null,
        ...data
    });
};

describe('executor shared-balance pools', () => {
    beforeEach(() => {
        resetStore();
        jest.clearAllMocks();

        ExecutorGroup.findById.mockImplementation((id) => {
            const group = store.groups.get(String(id));
            const doc = group ? { ...group } : null;
            const promise = Promise.resolve(doc);
            return {
                select() { return this; },
                lean: async () => doc,
                then: (resolve, reject) => promise.then(resolve, reject)
            };
        });
        ExecutorGroup.findOneAndUpdate.mockImplementation(async (filter, update, options = {}) => {
            const group = [...store.groups.values()].find((item) => matchesFilter(item, filter));
            if (!group) return null;
            applyInc(group, update);
            return options.new ? { ...group } : group;
        });
        ExecutorGroup.findByIdAndUpdate.mockImplementation(async (id, update, options = {}) => {
            const group = store.groups.get(String(id));
            if (!group) return null;
            applyInc(group, update);
            return options.new ? { ...group } : group;
        });
        Transaction.create.mockImplementation(async (data) => {
            const tx = { _id: `tx-${store.transactions.length + 1}`, ...data };
            store.transactions.push(tx);
            return tx;
        });
        Notification.create.mockImplementation(async (data) => {
            store.notifications.push(data);
            return data;
        });

        store.groups.set('group-1', { _id: 'group-1', name: 'شركة التنفيذ', balance: 10000 });
        seedEmployee({ _id: 'ahmed', name: 'أحمد', role: 'external', groupId: 'group-1', webUsername: 'ahmed@ahram.com' });
        seedEmployee({ _id: 'khaled', name: 'خالد', role: 'external', groupId: 'group-1', webUsername: 'khaled@ahram.com' });
        seedEmployee({ _id: 'mohamed', name: 'محمد', role: 'external', groupId: 'group-1', webUsername: 'mohamed@ahram.com' });
        seedEmployee({ _id: 'mustafa', name: 'مصطفى', role: 'external', groupId: 'group-1', webUsername: 'mustafa@ahram.com' });
        seedEmployee({ _id: 'mounir', name: 'منير', role: 'external', groupId: 'group-1', webUsername: 'mounir@ahram.com' });
        seedEmployee({ _id: 'operator-1', name: 'موظف داخلي', role: 'operator', groupId: 'group-1', webUsername: 'op@ahram.com' });
    });

    test('computes total as private plus unique pool and solo balances', () => {
        const snapshot = snapshotFromParts({
            group: { _id: 'group-1', name: 'شركة التنفيذ', balance: 7000 },
            pools: [{ _id: 'pool-nour', balance: 2500 }],
            employees: [
                { role: 'external', balance: 2500, balancePoolId: 'pool-nour' },
                { role: 'external', balance: 800, balancePoolId: null }
            ]
        });
        expect(snapshot).toMatchObject({
            groupId: 'group-1',
            name: 'شركة التنفيذ',
            privateBalance: 7000,
            allocatedBalance: 3300,
            totalBalance: 10300,
            primaryServiceKey: 'vodafone',
            multiService: false
        });
        expect(snapshot.byService).toEqual(expect.arrayContaining([
            expect.objectContaining({
                serviceKey: 'vodafone',
                privateBalance: 7000,
                allocatedBalance: 3300,
                totalBalance: 10300,
                appliesPoolModel: true
            })
        ]));
    });

    test('manager can name a pool and attach external executors; one membership only', async () => {
        const pool = await createPool({
            manager,
            name: 'شركة النور',
            memberIds: ['ahmed', 'khaled', 'mohamed']
        });
        expect(pool.name).toBe('شركة النور');
        expect(pool.memberCount).toBe(3);
        expect(store.employees.get('ahmed').balancePoolId).toBe(pool.id);
        expect(store.employees.get('mounir').balancePoolId).toBeNull();

        await expect(attachMembers({
            manager,
            poolId: pool.id,
            memberIds: ['operator-1']
        })).rejects.toMatchObject({ code: 'INVALID_MEMBER' });

        const second = await createPool({ manager, name: 'مجموعة خالد ومصطفى', memberIds: ['mustafa'] });
        await expect(attachMembers({
            manager,
            poolId: second.id,
            memberIds: ['khaled']
        })).rejects.toMatchObject({ code: 'ALREADY_IN_POOL' });
    });

    test('detaching the last member moves the shared balance to that solo executor', async () => {
        const pool = await createPool({ manager, name: 'شركة النور', memberIds: ['ahmed', 'khaled'] });
        store.pools.get(pool.id).balance = 400;
        await detachMember({ manager, poolId: pool.id, employeeId: 'ahmed' });
        expect(store.employees.get('ahmed').balancePoolId).toBeNull();
        expect(store.employees.get('ahmed').balance).toBe(0);
        expect(store.pools.get(pool.id).balance).toBe(400);

        await detachMember({ manager, poolId: pool.id, employeeId: 'khaled' });
        expect(store.employees.get('khaled').balancePoolId).toBeNull();
        expect(store.employees.get('khaled').balance).toBe(400);
        expect(store.pools.get(pool.id).balance).toBe(0);
    });

    test('funding an executor in a pool debits private balance, credits the shared pool, and keeps company total unchanged', async () => {
        const pool = await createPool({ manager, name: 'شركة النور', memberIds: ['ahmed', 'khaled', 'mohamed'] });
        const before = await snapshotCompanyBalances('group-1');
        expect(before.privateBalance).toBe(10000);
        expect(before.totalBalance).toBe(10000);

        const funded = await fundExternalExecutor({
            manager,
            employeeId: 'khaled',
            type: 'deposit',
            amount: 1500,
            note: 'تمويل مجموعة النور عبر خالد'
        });

        const after = await snapshotCompanyBalances('group-1');
        expect(after.privateBalance).toBe(8500);
        expect(after.allocatedBalance).toBe(1500);
        expect(after.totalBalance).toBe(10000);
        expect(store.pools.get(pool.id).balance).toBe(1500);
        expect(store.employees.get('ahmed').balance).toBe(0);
        expect(store.employees.get('khaled').balance).toBe(0);
        expect(funded.recipientId).toBe('khaled');
        expect(funded.workingBalance).toBe(1500);
    });

    test('solo executor keeps a private working balance separate from a named pool', async () => {
        await createPool({ manager, name: 'شركة النور', memberIds: ['ahmed', 'khaled'] });
        await fundExternalExecutor({ manager, employeeId: 'mounir', type: 'deposit', amount: 400 });
        const snapshot = await snapshotCompanyBalances('group-1');
        expect(snapshot.privateBalance).toBe(9600);
        expect(store.employees.get('mounir').balance).toBe(400);
        expect(store.employees.get('mounir').balancePoolId).toBeNull();
        expect(snapshot.totalBalance).toBe(10000);
    });

    test('deposit receipt and notification are only for the targeted executor, not every pool member', async () => {
        await createPool({ manager, name: 'شركة النور', memberIds: ['ahmed', 'khaled', 'mohamed'] });
        await fundExternalExecutor({
            manager,
            employeeId: 'ahmed',
            type: 'deposit',
            amount: 900
        });

        expect(store.transactions).toHaveLength(1);
        expect(store.transactions[0]).toMatchObject({
            operatorId: 'ahmed',
            transferType: 'external_balance',
            status: 'deposit',
            amount: 900
        });
        expect(store.notifications).toEqual([
            expect.objectContaining({
                userId: 'ahmed@ahram.com',
                metadata: expect.objectContaining({ recipientOnly: true, recipientId: 'ahmed' })
            })
        ]);
        expect(store.notifications.map((item) => item.userId)).toEqual(['ahmed@ahram.com']);

        const workspace = await listExternalBalanceWorkspace({ manager });
        const khaled = workspace.employees.find((item) => item.name === 'خالد');
        expect(khaled.workingBalance).toBe(900);
    });

    test('live deposit alerts for external funding match only the targeted operator, not the whole pool', () => {
        const query = depositAlertQuery({ _id: 'khaled', groupId: 'group-1', role: 'external' }, Date.now());
        expect(query.$and[2].$or[0]).toEqual({ operatorId: 'khaled', transferType: 'external_balance' });
        expect(query.$and[2].$or[1].transferType).toEqual({ $ne: 'external_balance' });

        const ahmedQuery = depositAlertQuery({ _id: 'ahmed', groupId: 'group-1' }, Date.now());
        expect(ahmedQuery.$and[2].$or[0].operatorId).toBe('ahmed');
        expect(ahmedQuery.$and[2].$or[0].operatorId).not.toBe('khaled');
    });

    test('insufficient private balance blocks funding an external executor', async () => {
        store.groups.get('group-1').balance = 50;
        await expect(fundExternalExecutor({
            manager,
            employeeId: 'mounir',
            type: 'deposit',
            amount: 80
        })).rejects.toMatchObject({ code: 'INSUFFICIENT_PRIVATE_BALANCE' });
        expect(store.employees.get('mounir').balance).toBe(0);
        expect(store.transactions).toHaveLength(0);
    });
});
