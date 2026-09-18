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
    },
    // Sub-account statements and mobile reports use this as their primary
    // access path. These indexes must be created explicitly because autoIndex
    // is disabled in production.
    {
        key: { subAccountId: 1, createdAt: -1 },
        name: 'clientPortal_subAccount_createdAt'
    },
    {
        key: { tenantId: 1, subAccountId: 1, createdAt: -1 },
        name: 'clientPortal_tenant_subAccount_createdAt'
    }
];

const liveOperationsIndexes = [
    { key: { tenantId: 1, status: 1, transferType: 1, createdAt: -1 }, name: 'liveOps_tenant_status_type_createdAt' },
    { key: { tenantId: 1, amount: -1, createdAt: -1 }, name: 'liveOps_tenant_amount_createdAt' },
    { key: { tenantId: 1, vodafoneNumber: 1, createdAt: -1 }, name: 'liveOps_tenant_phone_createdAt' },
    { key: { tenantId: 1, accountNumber: 1, createdAt: -1 }, name: 'liveOps_tenant_account_createdAt' },
    {
        key: { tenantId: 1, originCountry: 1, createdAt: -1 },
        name: 'opsGeo_tenant_originCountry_createdAt',
        partialFilterExpression: { originCountry: { $type: 'string', $gt: '' } }
    },
    { key: { tenantId: 1, userId: 1, createdAt: -1 }, name: 'opsBehavior_tenant_user_createdAt' },
    { key: { tenantId: 1, companyId: 1, createdAt: -1 }, name: 'opsBehavior_tenant_company_createdAt' }
];

const ensurePerformanceIndexes = async () => {
    try {
        await Transaction.collection.createIndexes([
            ...executorTaskIndexes,
            ...transferCooldownIndexes,
            ...clientPortalIndexes,
            ...liveOperationsIndexes
        ]);
        logger.info('Transaction performance indexes are ready');
        return true;
    } catch (error) {
        logger.error('Failed to create transaction performance indexes', { error: error.message });
        return false;
    }
};

module.exports = { ensurePerformanceIndexes, clientPortalIndexes, liveOperationsIndexes };
