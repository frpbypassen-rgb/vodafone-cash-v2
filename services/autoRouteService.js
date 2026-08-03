'use strict';

const ExecutorGroup = require('../models/ExecutorGroup');
const logger = require('../utils/logger');

const getParentGroupId = (group) => group?.parentGroupId || group?.parentBotId || null;

const runQuery = (query, session) => {
    if (session && query && typeof query.session === 'function') {
        return query.session(session);
    }
    return query;
};

const resolveAutoRouteExecutor = async (settings, session = null) => {
    if (!settings || !settings.autoRouteEnabled || !settings.autoRouteBotId) {
        return null;
    }

    const executorGroup = await runQuery(ExecutorGroup.findById(settings.autoRouteBotId), session);
    if (!executorGroup || executorGroup.status !== 'active' || executorGroup.isManagerBot) {
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
    if (!tx || !executorGroup || !executorGroup.isApiBot) {
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
    resolveAutoRouteExecutor,
    applyAutoRouteFields,
    enqueueAutoRouteIfNeeded
};
