'use strict';

const ExecutorGroup = require('../models/ExecutorGroup');
const logger = require('../utils/logger');
const { executorSupportsTransferType } = require('../utils/executorServiceCatalog');

const getParentGroupId = (group) => group?.parentGroupId || group?.parentBotId || null;

const runQuery = (query, session) => {
    if (session && query && typeof query.session === 'function') {
        return query.session(session);
    }
    return query;
};

const getConfiguredAutoRouteExecutorId = (settings, transferType = 'vodafone') => {
    const rules = Array.isArray(settings?.autoRouteRules) ? settings.autoRouteRules : [];
    const serviceKey = String(transferType || 'vodafone').trim().toLowerCase();
    const rule = rules.find((item) => String(item?.serviceKey || '').trim().toLowerCase() === serviceKey);
    if (rule?.executorGroupId) return rule.executorGroupId;

    // Legacy installations had one executor for every operation. Use it only
    // until service-specific rules are saved for the first time.
    return rules.length === 0 ? settings?.autoRouteBotId || null : null;
};

const resolveAutoRouteExecutor = async (settings, transferType = 'vodafone', session = null) => {
    const executorGroupId = getConfiguredAutoRouteExecutorId(settings, transferType);
    if (!settings || !settings.autoRouteEnabled || !executorGroupId) {
        return null;
    }

    const executorGroup = await runQuery(ExecutorGroup.findById(executorGroupId), session);
    if (
        !executorGroup
        || executorGroup.status !== 'active'
        || executorGroup.isManagerBot
        || !executorSupportsTransferType(executorGroup, transferType)
    ) {
        return null;
    }

    return executorGroup;
};

const applyAutoRouteFields = (tx, executorGroup) => {
    if (!tx || !executorGroup) return tx;

    tx.executorGroupId = executorGroup._id;
    tx.managerGroupId = getParentGroupId(executorGroup);
    tx.executorName = executorGroup.name;
    tx.status = 'processing';
    tx.broadcastMessages = [];

    return tx;
};

const enqueueAutoRouteIfNeeded = async (tx, executorGroup) => {
    if (
        !tx
        || !executorGroup
        || !executorGroup.isApiBot
        || !executorSupportsTransferType(executorGroup, tx.transferType)
    ) {
        return { queued: false };
    }

    const { addTransferJob } = require('./bullQueueService');
    await addTransferJob(String(tx._id), String(executorGroup._id));
    logger.info('Auto-route API job queued', {
        txId: tx.customId || String(tx._id),
        executorGroupId: String(executorGroup._id)
    });

    return { queued: true };
};

module.exports = {
    getParentGroupId,
    getConfiguredAutoRouteExecutorId,
    resolveAutoRouteExecutor,
    applyAutoRouteFields,
    enqueueAutoRouteIfNeeded
};
