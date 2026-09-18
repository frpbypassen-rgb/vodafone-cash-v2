'use strict';

jest.mock('../models/Transaction', () => ({
    collection: { createIndexes: jest.fn() }
}));
jest.mock('../models/OpsInternalNote', () => ({
    collection: { createIndexes: jest.fn() }
}));
jest.mock('../models/OpsWatchTask', () => ({
    collection: { createIndexes: jest.fn() }
}));
jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn()
}));

const Transaction = require('../models/Transaction');
const OpsInternalNote = require('../models/OpsInternalNote');
const OpsWatchTask = require('../models/OpsWatchTask');
const logger = require('../utils/logger');
const { ensurePerformanceIndexes } = require('../services/performanceIndexService');

describe('performanceIndexService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('creates the cooldown indexes during startup', async () => {
        Transaction.collection.createIndexes.mockResolvedValue([]);
        OpsInternalNote.collection.createIndexes.mockResolvedValue([]);
        OpsWatchTask.collection.createIndexes.mockResolvedValue([]);

        await expect(ensurePerformanceIndexes()).resolves.toBe(true);

        expect(Transaction.collection.createIndexes).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({
                name: 'transferCooldownExact_v1',
                key: expect.objectContaining({
                    requestOwnerKey: 1,
                    canonicalRecipient: 1,
                    amount: 1
                })
            }),
            expect.objectContaining({
                name: 'transferCooldownRecipient_v1',
                key: expect.objectContaining({
                    requestOwnerKey: 1,
                    canonicalRecipient: 1,
                    status: 1
                })
            })
        ]));
        expect(Transaction.collection.createIndexes).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({
                name: 'opsGeo_tenant_originCountry_createdAt',
                key: expect.objectContaining({ tenantId: 1, originCountry: 1, createdAt: -1 })
            }),
            expect.objectContaining({
                name: 'opsBehavior_tenant_user_createdAt',
                key: expect.objectContaining({ tenantId: 1, userId: 1, createdAt: -1 })
            }),
            expect.objectContaining({
                name: 'opsBehavior_tenant_company_createdAt',
                key: expect.objectContaining({ tenantId: 1, companyId: 1, createdAt: -1 })
            }),
            expect.objectContaining({
                name: 'opsLive_tenant_updatedAt',
                key: expect.objectContaining({ tenantId: 1, updatedAt: -1 })
            })
        ]));
        expect(OpsInternalNote.collection.createIndexes).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ name: 'opsNote_tx_createdAt' })
        ]));
        expect(OpsWatchTask.collection.createIndexes).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ name: 'opsTask_tx_status_createdAt' })
        ]));
        expect(logger.info).toHaveBeenCalled();
    });

    test('does not prevent startup if index creation fails', async () => {
        Transaction.collection.createIndexes.mockRejectedValueOnce(new Error('index failure'));

        await expect(ensurePerformanceIndexes()).resolves.toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
            'Failed to create transaction performance indexes',
            expect.objectContaining({ error: 'index failure' })
        );
    });
});
