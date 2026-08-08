'use strict';

jest.mock('../models/Transaction', () => ({
    collection: { createIndexes: jest.fn() }
}));
jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    error: jest.fn()
}));

const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const { ensurePerformanceIndexes } = require('../services/performanceIndexService');

describe('performanceIndexService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('creates the cooldown indexes during startup', async () => {
        Transaction.collection.createIndexes.mockResolvedValue([]);

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
