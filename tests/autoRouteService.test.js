'use strict';

jest.mock('../models/ExecutorGroup', () => ({
    findById: jest.fn()
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
});
