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
            autoRouteBotId: 'api-group-1'
        });
        applyAutoRouteFields(tx, resolved);
        await enqueueAutoRouteIfNeeded(tx, resolved);

        expect(resolved).toBe(executorGroup);
        expect(tx.status).toBe('processing');
        expect(tx.executorGroupId).toBe('api-group-1');
        expect(tx.managerGroupId).toBe('manager-1');
        expect(tx.executorName).toBe('Zayn API');
        expect(addTransferJob).toHaveBeenCalledWith('tx-1', 'api-group-1');
    });
});
