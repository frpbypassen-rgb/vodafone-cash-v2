'use strict';

const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

const executorTaskIndexes = [
    {
        key: { executorGroupId: 1, status: 1, executorReceivedAt: 1 },
        name: 'executorGroupId_1_status_1_executorReceivedAt_1'
    },
    {
        key: { managerGroupId: 1, status: 1, executorReceivedAt: 1 },
        name: 'managerGroupId_1_status_1_executorReceivedAt_1'
    },
    {
        key: { executorGroupId: 1, status: 1, updatedAt: -1 },
        name: 'executorGroupId_1_status_1_updatedAt_-1'
    },
    {
        key: { managerGroupId: 1, status: 1, updatedAt: -1 },
        name: 'managerGroupId_1_status_1_updatedAt_-1'
    }
];

const transferCooldownIndexes = [
    {
        key: {
            requestOwnerKey: 1,
            canonicalServiceKey: 1,
            canonicalRecipient: 1,
            amount: 1,
            status: 1,
            createdAt: -1
        },
        name: 'transferCooldownExact_v1',
        partialFilterExpression: {
            requestOwnerKey: { $exists: true },
            canonicalServiceKey: { $exists: true },
            canonicalRecipient: { $exists: true }
        }
    },
    {
        key: {
            requestOwnerKey: 1,
            canonicalServiceKey: 1,
            canonicalRecipient: 1,
            status: 1,
            createdAt: -1
        },
        name: 'transferCooldownRecipient_v1',
        partialFilterExpression: {
            requestOwnerKey: { $exists: true },
            canonicalServiceKey: { $exists: true },
            canonicalRecipient: { $exists: true }
        }
    }
];

const ensurePerformanceIndexes = async () => {
    try {
        await Transaction.collection.createIndexes([...executorTaskIndexes, ...transferCooldownIndexes]);
        logger.info('Transaction performance indexes are ready');
        return true;
    } catch (error) {
        logger.error('Failed to create transaction performance indexes', { error: error.message });
        return false;
    }
};

module.exports = { ensurePerformanceIndexes };
