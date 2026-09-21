'use strict';

const Transaction = require('../models/Transaction');
const { taskOwnershipFilter } = require('./executorTaskRoutingService');
const { toExecutorPortalTaskDto } = require('../utils/executorTaskPrivacy');
const { systemDayStart, systemDayEnd, systemDateKey } = require('../config/systemTime');

const COMPLETED_TODAY_LIMIT = 60;
const DEP_ALERT_LIMIT = 20;
const DEP_ALERT_LOOKBACK_MS = 36 * 60 * 60 * 1000;
const IDLE_POLL_INTERVAL_SECONDS = 12;
const BUSY_POLL_INTERVAL_SECONDS = 8;
const LIVE_TASK_STATUSES = ['processing', 'accepted'];
const MOBILE_LIVE_TASK_STATUSES = ['processing', 'pending', 'accepted'];
const DELAYED_TASK_MS = 120000;
const DELAYED_TASK_ALERT = 'تأخير استجابة! الطلب تخطى 120 ثانية ولم يقبله أحد، يرجى سحبه فوراً!';

const LIVE_TASK_PROJECTION = [
    '_id',
    'customId',
    'transferType',
    'amount',
    'vodafoneNumber',
    'accountNumber',
    'accountName',
    'serviceDetails.recipientPhone',
    'notes',
    'status',
    'operatorId',
    'executorName',
    'assignedExecutorId',
    'assignedExecutorName',
    'executorReceivedAt',
    'createdAt',
    'updatedAt',
    'emergencyAlert',
    'notifiedExecutors',
    'autoAlertFired',
    'executorWebAlert'
].join(' ');

const COMPLETED_TODAY_PROJECTION = 'customId amount transferType vodafoneNumber accountNumber updatedAt completedAt executorName';

const objectIdString = (value) => String(value?._id || value || '');

const taskArrivalTime = (tx) => {
    const value = new Date(tx.executorReceivedAt || tx.createdAt || 0).getTime();
    return Number.isFinite(value) ? value : 0;
};

const completedTodayScope = (emp) => {
    const groupId = objectIdString(emp.groupId);
    const seesGroupCompletedToday = emp.role === 'manager' || emp.role === 'accountant';
    if (seesGroupCompletedToday) {
        return { $or: [{ executorGroupId: groupId }, { managerGroupId: groupId }] };
    }
    return { operatorId: objectIdString(emp._id) };
};

const completedTodayDateClause = (dayStart, dayEnd) => {
    const range = { $gte: dayStart, $lte: dayEnd };
    return {
        $or: [
            { completedAt: range },
            {
                $and: [
                    { $or: [{ completedAt: null }, { completedAt: { $exists: false } }] },
                    { updatedAt: range }
                ]
            }
        ]
    };
};

const completedTodayQuery = (emp, now = new Date()) => {
    const todayKey = systemDateKey(now);
    const dayStart = systemDayStart(todayKey);
    const dayEnd = systemDayEnd(todayKey);
    const scope = completedTodayScope(emp);
    if (dayStart && dayEnd) {
        return { $and: [{ status: 'completed' }, scope, completedTodayDateClause(dayStart, dayEnd)] };
    }
    return { status: 'completed', ...scope };
};

const liveTaskFilter = (emp, statuses, tenantId = null) => {
    const filter = {
        ...taskOwnershipFilter(emp),
        status: { $in: statuses }
    };
    if (tenantId) filter.tenantId = tenantId;
    return filter;
};

const depositAlertQuery = (emp, now = Date.now()) => {
    const groupId = objectIdString(emp.groupId);
    const selfId = objectIdString(emp._id);
    return {
        $and: [
            { executorWebAlert: { $exists: true, $ne: null } },
            { updatedAt: { $gte: new Date(now - DEP_ALERT_LOOKBACK_MS) } },
            {
                $or: [
                    { operatorId: selfId, transferType: 'external_balance' },
                    {
                        transferType: { $ne: 'external_balance' },
                        $or: [
                            { operatorId: selfId },
                            { executorGroupId: groupId },
                            { managerGroupId: groupId }
                        ]
                    }
                ]
            }
        ]
    };
};

const applyLiveTaskHousekeeping = async (tasks, now = Date.now()) => {
    const notificationIds = tasks
        .filter((tx) => tx.status === 'processing' && !tx.notifiedExecutors)
        .map((tx) => tx._id);
    const delayedTaskIds = tasks
        .filter((tx) => tx.status === 'processing' && !tx.autoAlertFired && now - taskArrivalTime(tx) >= DELAYED_TASK_MS)
        .map((tx) => tx._id);

    await Promise.all([
        notificationIds.length
            ? Transaction.updateMany(
                { _id: { $in: notificationIds }, notifiedExecutors: { $ne: true } },
                { $set: { notifiedExecutors: true } },
                { strict: false }
            )
            : Promise.resolve(),
        delayedTaskIds.length
            ? Transaction.updateMany(
                { _id: { $in: delayedTaskIds }, autoAlertFired: { $ne: true } },
                { $set: { emergencyAlert: DELAYED_TASK_ALERT, autoAlertFired: true } },
                { strict: false }
            )
            : Promise.resolve()
    ]);

    if (!delayedTaskIds.length) return tasks;
    const delayed = new Set(delayedTaskIds.map((id) => String(id)));
    return tasks.map((tx) => (
        delayed.has(String(tx._id))
            ? { ...tx, emergencyAlert: tx.emergencyAlert || DELAYED_TASK_ALERT, autoAlertFired: true }
            : tx
    ));
};

const pollIntervalSecondsFor = (tasks) => (
    tasks.some((tx) => tx.status === 'processing' || tx.status === 'accepted')
        ? BUSY_POLL_INTERVAL_SECONDS
        : IDLE_POLL_INTERVAL_SECONDS
);

const loadPortalLiveTasks = async ({ emp, includeCompletedList = true, now = new Date() } = {}) => {
    const filter = liveTaskFilter(emp, LIVE_TASK_STATUSES);
    let liveQuery = Transaction.find(filter);
    if (typeof liveQuery.select === 'function') liveQuery = liveQuery.select(LIVE_TASK_PROJECTION);
    const rawTasks = await (typeof liveQuery.lean === 'function' ? liveQuery.lean() : liveQuery);
    const tasks = Array.isArray(rawTasks) ? [...rawTasks] : [];
    tasks.sort((first, second) => taskArrivalTime(first) - taskArrivalTime(second));
    const liveTasks = await applyLiveTaskHousekeeping(tasks, now.getTime());

    const completedQuery = completedTodayQuery(emp, now);
    const depQuery = Transaction.find(depositAlertQuery(emp, now.getTime()));
    const depAlertsQuery = typeof depQuery.select === 'function'
        ? depQuery.select('_id executorWebAlert').sort({ updatedAt: -1 }).limit(DEP_ALERT_LIMIT)
        : depQuery;
    const queries = [
        typeof depAlertsQuery.lean === 'function' ? depAlertsQuery.lean() : depAlertsQuery,
        Transaction.aggregate([
            { $match: completedQuery },
            { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } }
        ])
    ];
    if (includeCompletedList) {
        let completedListQuery = Transaction.find(completedQuery)
            .sort({ updatedAt: -1 })
            .limit(COMPLETED_TODAY_LIMIT);
        if (typeof completedListQuery.select === 'function') {
            completedListQuery = completedListQuery.select(COMPLETED_TODAY_PROJECTION);
        }
        queries.push(typeof completedListQuery.lean === 'function' ? completedListQuery.lean() : completedListQuery);
    }

    const [depAlerts, completedTodayStats, completedToday = []] = await Promise.all(queries);
    const completedTodaySummary = completedTodayStats[0] || { count: 0, amount: 0 };

    return {
        tasks: liveTasks.map((tx) => toExecutorPortalTaskDto(tx, emp._id)),
        alerts: liveTasks
            .filter((tx) => tx.emergencyAlert)
            .map((tx) => toExecutorPortalTaskDto(tx, emp._id)),
        depAlerts: (depAlerts || []).map((tx) => ({
            _id: String(tx._id),
            executorWebAlert: tx.executorWebAlert || null
        })),
        completedToday: includeCompletedList ? (completedToday || []) : [],
        completedTodaySummary,
        manualTaskRoutingEnabled: Boolean(emp.groupId?.manualTaskRoutingEnabled),
        canRouteTasks: emp.role === 'manager',
        pollIntervalSeconds: pollIntervalSecondsFor(liveTasks)
    };
};

const loadMobileLiveTasks = async ({ emp, tenantId = null } = {}) => {
    const filter = liveTaskFilter(emp, MOBILE_LIVE_TASK_STATUSES, tenantId);
    let query = Transaction.find(filter);
    if (typeof query.select === 'function') query = query.select(LIVE_TASK_PROJECTION);
    if (typeof query.sort === 'function') query = query.sort({ createdAt: 1 });
    const tasks = await (typeof query.lean === 'function' ? query.lean() : query);
    const list = Array.isArray(tasks) ? tasks : [];
    return {
        tasks: list,
        alerts: list.filter((tx) => tx.emergencyAlert),
        pollIntervalSeconds: pollIntervalSecondsFor(list)
    };
};

module.exports = {
    BUSY_POLL_INTERVAL_SECONDS,
    COMPLETED_TODAY_LIMIT,
    DELAYED_TASK_ALERT,
    DEP_ALERT_LIMIT,
    DEP_ALERT_LOOKBACK_MS,
    IDLE_POLL_INTERVAL_SECONDS,
    LIVE_TASK_PROJECTION,
    completedTodayQuery,
    depositAlertQuery,
    loadMobileLiveTasks,
    loadPortalLiveTasks,
    pollIntervalSecondsFor
};
