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

// Portal reports and the live dashboard filter by owner, employee actor and
// recency. These are created explicitly because production commonly disables
// Mongoose autoIndex for faster boot.
const clientPortalIndexes = [
    {
        key: { companyId: 1, clientActorId: 1, createdAt: -1 },
        name: 'clientPortal_company_actor_createdAt'
    },
    {
        key: { userId: 1, clientActorId: 1, createdAt: -1 },
        name: 'clientPortal_user_actor_createdAt'
    },
    {
        key: { tenantId: 1, companyId: 1, clientActorId: 1, createdAt: -1 },
        name: 'clientPortal_tenant_company_actor_createdAt'
    },
    {
        key: { tenantId: 1, userId: 1, clientActorId: 1, createdAt: -1 },
        name: 'clientPortal_tenant_user_actor_createdAt'
    }
];

const ensurePerformanceIndexes = async () => {
    try {
        await Transaction.collection.createIndexes([
            ...executorTaskIndexes,
            ...transferCooldownIndexes,
            ...clientPortalIndexes
        ]);
        logger.info('Transaction performance indexes are ready');
        return true;
    } catch (error) {
        logger.error('Failed to create transaction performance indexes', { error: error.message });
        return false;
    }
};

module.exports = { ensurePerformanceIndexes, clientPortalIndexes };
