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

const ensurePerformanceIndexes = async () => {
    try {
        await Transaction.collection.createIndexes(executorTaskIndexes);
        logger.info('Executor task performance indexes are ready');
        return true;
    } catch (error) {
        logger.error('Failed to create executor task performance indexes', { error: error.message });
        return false;
    }
};

module.exports = { ensurePerformanceIndexes };
