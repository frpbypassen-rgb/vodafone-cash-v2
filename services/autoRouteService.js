'use strict';

const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const { executorSupportsTransferType } = require('../utils/executorServiceCatalog');
const eventBus = require('./eventBus');

const getParentGroupId = (group) => group?.parentGroupId || group?.parentBotId || null;
const OPEN_TASK_STATUSES = Object.freeze(['processing', 'accepted']);
const SMART_ROUTE_OUTCOME_STATUSES = Object.freeze(['completed', 'rejected', 'cancelled_by_admin']);
const SMART_ROUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

const idOf = (value) => String(value?._id || value || '');
const positiveNumber = (value) => Math.max(0, Number(value) || 0);

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

const queryAggregate = async (pipeline, session) => {
    const query = Transaction.aggregate(pipeline);
    if (session && query && typeof query.session === 'function') return query.session(session);
    return query;
};

const getSmartRoutingMetrics = async (executorIds, parentIds, session) => {
    const now = new Date();
    const recentSince = new Date(now.getTime() - SMART_ROUTE_WINDOW_MS);
    const metricRows = await queryAggregate([
        {
            $match: {
                executorGroupId: { $in: executorIds },
                status: { $in: [...OPEN_TASK_STATUSES, ...SMART_ROUTE_OUTCOME_STATUSES] }
            }
        },
        {
            $group: {
                _id: '$executorGroupId',
                openTasks: {
                    $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, 1, 0] }
                },
                reservedAmount: {
                    $sum: { $cond: [{ $in: ['$status', OPEN_TASK_STATUSES] }, '$amount', 0] }
                },
                completed24h: {
                    $sum: {
                        $cond: [{
                            $and: [
                                { $eq: ['$status', 'completed'] },
                                { $gte: ['$completedAt', recentSince] }
                            ]
                        }, 1, 0]
                    }
                },
                rejected24h: {
                    $sum: {
                        $cond: [{
                            $and: [
                                { $in: ['$status', ['rejected', 'cancelled_by_admin']] },
                                { $gte: ['$updatedAt', recentSince] }
                            ]
                        }, 1, 0]
                    }
                },
                lastRoutedAt: { $max: '$executorReceivedAt' }
            }
        }
    ], session);

    const parentRows = parentIds.length
        ? await queryAggregate([
            {
                $match: {
                    managerGroupId: { $in: parentIds },
                    status: { $in: OPEN_TASK_STATUSES }
                }
            },
            { $group: { _id: '$managerGroupId', reservedAmount: { $sum: '$amount' } } }
        ], session)
        : [];

    return {
        byExecutor: new Map((metricRows || []).map((row) => [idOf(row._id), row])),
        reservedByParent: new Map((parentRows || []).map((row) => [idOf(row._id), positiveNumber(row.reservedAmount)]))
    };
};

const smartRouteScore = (metrics) => {
    const completed = positiveNumber(metrics.completed24h);
    const rejected = positiveNumber(metrics.rejected24h);
    const outcomes = completed + rejected;
    // A poor recent completion ratio matters, but never outweighs an already
    // overloaded queue. This keeps distribution fair while favouring reliable
    // executors when their workload is otherwise similar.
    const reliabilityPenalty = outcomes >= 4
        ? Math.round((rejected / outcomes) * 500)
        : rejected * 80;
    return (positiveNumber(metrics.openTasks) * 10000)
        + reliabilityPenalty
        + (completed * 4);
};

const resolveSmartAutoRouteExecutor = async (settings, transferType, amount, session) => {
    const requestedAmount = positiveNumber(amount);
    if (!requestedAmount) return null;

    const candidates = await runQuery(ExecutorGroup.find({
        status: 'active',
        isManagerBot: { $ne: true }
    }), session);
    const compatible = (candidates || []).filter((group) =>
        !group.isManagerBot && executorSupportsTransferType(group, transferType)
    );
    if (!compatible.length) return null;

    const parentIds = [...new Set(compatible.map((group) => idOf(getParentGroupId(group))).filter(Boolean))];
    const parentGroups = parentIds.length
        ? await runQuery(ExecutorGroup.find({ _id: { $in: parentIds }, status: 'active' }), session)
        : [];
    const parentsById = new Map((parentGroups || []).map((group) => [idOf(group), group]));
    const { byExecutor, reservedByParent } = await getSmartRoutingMetrics(
        compatible.map((group) => group._id),
        parentIds,
        session
    );

    const eligible = compatible.map((group) => {
        const metrics = byExecutor.get(idOf(group)) || {};
        const reservedAmount = positiveNumber(metrics.reservedAmount);
        const availableBalance = positiveNumber(group.balance) - reservedAmount;
        const parentId = idOf(getParentGroupId(group));
        const parent = parentId ? parentsById.get(parentId) : null;
        const parentAvailableBalance = parent
            ? positiveNumber(parent.balance) - positiveNumber(reservedByParent.get(parentId))
            : Number.POSITIVE_INFINITY;

        return {
            group,
            metrics,
            availableBalance,
            parentAvailableBalance,
            score: smartRouteScore(metrics)
        };
    }).filter((candidate) =>
        candidate.availableBalance >= requestedAmount
        && candidate.parentAvailableBalance >= requestedAmount
    );

    eligible.sort((left, right) => {
        if (left.score !== right.score) return left.score - right.score;
        const leftLastRoute = new Date(left.metrics.lastRoutedAt || 0).getTime();
        const rightLastRoute = new Date(right.metrics.lastRoutedAt || 0).getTime();
        if (leftLastRoute !== rightLastRoute) return leftLastRoute - rightLastRoute;
        // With equal load and history, use more available funds as the final
        // deterministic tie-breaker.
        if (left.availableBalance !== right.availableBalance) {
            return right.availableBalance - left.availableBalance;
        }
        return idOf(left.group).localeCompare(idOf(right.group));
    });

    const selected = eligible[0];
    if (!selected) {
        logger.warn('Smart auto-route has no executor with sufficient capacity', {
            transferType,
            amount: requestedAmount,
            compatibleExecutors: compatible.length
        });
        return null;
    }

    logger.info('Smart auto-route selected executor', {
        transferType,
        amount: requestedAmount,
        executorGroupId: idOf(selected.group),
        openTasks: positiveNumber(selected.metrics.openTasks),
        availableBalance: selected.availableBalance,
        candidates: eligible.length
    });
    return selected.group;
};

const resolveAutoRouteExecutor = async (settings, transferType = 'vodafone', session = null, amount = 0) => {
    if (!settings || !settings.autoRouteEnabled) return null;

    if (settings.autoRouteStrategy === 'smart') {
        return resolveSmartAutoRouteExecutor(settings, transferType, amount, session);
    }

    const executorGroupId = getConfiguredAutoRouteExecutorId(settings, transferType);
    if (!executorGroupId) {
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
    tx.executorReceivedAt = new Date();
    tx.executorName = executorGroup.name;
    tx.status = 'processing';
    tx.broadcastMessages = [];

    return tx;
};

const enqueueAutoRouteIfNeeded = async (tx, executorGroup) => {
    if (tx && executorGroup) {
        eventBus.publish('executor:task-available', { tx, source: 'auto-route' });
    }
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
    resolveSmartAutoRouteExecutor,
    resolveAutoRouteExecutor,
    applyAutoRouteFields,
    enqueueAutoRouteIfNeeded
};
