'use strict';

jest.mock('../models/ExecutorGroup', () => ({
    findById: jest.fn(),
    find: jest.fn()
}));

jest.mock('../models/Transaction', () => ({
    aggregate: jest.fn()
}));

jest.mock('../services/bullQueueService', () => ({
    addTransferJob: jest.fn()
}));

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const { addTransferJob } = require('../services/bullQueueService');
const {
    getConfiguredAutoRouteExecutorId,
    resolveAutoRouteExecutor,
    applyAutoRouteFields,
    enqueueAutoRouteIfNeeded
} = require('../services/autoRouteService');

describe('autoRouteService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('routes transaction to selected active API executor and queues execution', async () => {
        const executorGroup = {
            _id: 'api-group-1',
            name: 'Zayn API',
            status: 'active',
            isApiBot: true,
            isManagerBot: false,
            serviceKey: 'vodafone',
            parentGroupId: 'manager-1'
        };
        const tx = {
            _id: 'tx-1',
            customId: 'ATT-2608-0002',
            status: 'pending'
        };

        ExecutorGroup.findById.mockResolvedValue(executorGroup);
        addTransferJob.mockResolvedValue(undefined);

        const resolved = await resolveAutoRouteExecutor({
            autoRouteEnabled: true,
            autoRouteRules: [{ serviceKey: 'vodafone', executorGroupId: 'api-group-1' }]
        }, 'vodafone');
        applyAutoRouteFields(tx, resolved);
        await enqueueAutoRouteIfNeeded(tx, resolved);

        expect(resolved).toBe(executorGroup);
        expect(tx.status).toBe('processing');
        expect(tx.executorGroupId).toBe('api-group-1');
        expect(tx.managerGroupId).toBe('manager-1');
        expect(tx.executorReceivedAt).toBeInstanceOf(Date);
        expect(tx.executorName).toBe('Zayn API');
        expect(addTransferJob).toHaveBeenCalledWith('tx-1', 'api-group-1');
    });

    test('selects the postal executor for both postal operation types', async () => {
        const postalExecutor = {
            _id: 'postal-group-1',
            name: 'منفذ البريد',
            status: 'active',
            isApiBot: false,
            isManagerBot: false,
            serviceKey: 'postal'
        };
        ExecutorGroup.findById.mockResolvedValue(postalExecutor);
        const settings = {
            autoRouteEnabled: true,
            autoRouteRules: [
                { serviceKey: 'post_account', executorGroupId: 'postal-group-1' },
                { serviceKey: 'post_card', executorGroupId: 'postal-group-1' }
            ]
        };

        expect(getConfiguredAutoRouteExecutorId(settings, 'post_account')).toBe('postal-group-1');
        expect(await resolveAutoRouteExecutor(settings, 'post_card')).toBe(postalExecutor);
    });

    test('refuses an executor whose assigned service does not match the transaction', async () => {
        ExecutorGroup.findById.mockResolvedValue({
            _id: 'postal-group-1',
            status: 'active',
            isManagerBot: false,
            serviceKey: 'postal'
        });

        const result = await resolveAutoRouteExecutor({
            autoRouteEnabled: true,
            autoRouteRules: [{ serviceKey: 'vodafone', executorGroupId: 'postal-group-1' }]
        }, 'vodafone');

        expect(result).toBeNull();
    });

    test('does not fall back to the legacy executor when service rules exist', () => {
        expect(getConfiguredAutoRouteExecutorId({
            autoRouteBotId: 'legacy-group',
            autoRouteRules: [{ serviceKey: 'vodafone', executorGroupId: 'cash-group' }]
        }, 'bank_account')).toBeNull();
    });

    test('smart routing excludes insufficient balance and selects the least loaded reliable executor', async () => {
        const insufficient = {
            _id: 'insufficient', name: 'رصيد غير كافٍ', status: 'active',
            isManagerBot: false, serviceKey: 'vodafone', balance: 99
        };
        const overloaded = {
            _id: 'overloaded', name: 'قائمة مشغولة', status: 'active',
            isManagerBot: false, serviceKey: 'vodafone', balance: 2000
        };
        const balanced = {
            _id: 'balanced', name: 'أفضل منفذ', status: 'active',
            isManagerBot: false, serviceKey: 'vodafone', balance: 2000
        };
        ExecutorGroup.find.mockResolvedValue([insufficient, overloaded, balanced]);
        Transaction.aggregate.mockResolvedValue([
            { _id: 'overloaded', openTasks: 3, reservedAmount: 900, completed24h: 8, rejected24h: 0, lastRoutedAt: new Date() },
            { _id: 'balanced', openTasks: 0, reservedAmount: 0, completed24h: 3, rejected24h: 0, lastRoutedAt: new Date(Date.now() - 60_000) }
        ]);

        const resolved = await resolveAutoRouteExecutor({
            autoRouteEnabled: true,
            autoRouteStrategy: 'smart'
        }, 'vodafone', null, 100);

        expect(resolved).toBe(balanced);
        expect(ExecutorGroup.find).toHaveBeenCalledWith({
            status: 'active',
            isManagerBot: { $ne: true }
        });
    });

    test('smart routing leaves the transaction pending when no executor has enough available capacity', async () => {
        ExecutorGroup.find.mockResolvedValue([{
            _id: 'low-credit', status: 'active', isManagerBot: false,
            serviceKey: 'vodafone', balance: 500
        }]);
        Transaction.aggregate.mockResolvedValue([
            { _id: 'low-credit', openTasks: 1, reservedAmount: 450, completed24h: 0, rejected24h: 0 }
        ]);

        const resolved = await resolveAutoRouteExecutor({
            autoRouteEnabled: true,
            autoRouteStrategy: 'smart'
        }, 'vodafone', null, 100);

        expect(resolved).toBeNull();
    });

    test('smart routing honours the available balance of the parent execution team', async () => {
        const child = {
            _id: 'child', status: 'active', isManagerBot: false,
            serviceKey: 'vodafone', balance: 1000, parentGroupId: 'parent'
        };
        const parent = { _id: 'parent', status: 'active', balance: 200 };
        ExecutorGroup.find.mockImplementation((query) =>
            query?._id ? Promise.resolve([parent]) : Promise.resolve([child])
        );
        Transaction.aggregate
            .mockResolvedValueOnce([
                { _id: 'child', openTasks: 0, reservedAmount: 0, completed24h: 0, rejected24h: 0 }
            ])
            .mockResolvedValueOnce([{ _id: 'parent', reservedAmount: 150 }]);

        const resolved = await resolveAutoRouteExecutor({
            autoRouteEnabled: true,
            autoRouteStrategy: 'smart'
        }, 'vodafone', null, 100);

        expect(resolved).toBeNull();
    });
});
