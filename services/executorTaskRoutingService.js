'use strict';

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { acquireLock, releaseLock } = require('./lockService');
const eventBus = require('./eventBus');

const stringId = (value) => String(value?._id || value || '');
const ACCEPTABLE_TASK_STATUSES = ['processing', 'pending'];

// Older task rows in production sometimes stored the executor's login name
// instead of the Employee _id. Keep that compatibility narrowly scoped to
// the authenticated executor's own persisted identities.
const executorIdentityKeys = (executor) => {
    if (!executor || typeof executor !== 'object') {
        return [stringId(executor)].filter(Boolean);
    }
    return [...new Set([
        stringId(executor._id),
        String(executor.webUsername || '').trim()
    ].filter(Boolean))];
};

const isTaskOwnedByExecutor = (transaction, executor) => {
    if (!transaction) return false;
    const identities = new Set(executorIdentityKeys(executor));
    return [transaction.operatorId, transaction.assignedExecutorId]
        .map(stringId)
        .some((ownerId) => identities.has(ownerId));
};

const taskGroupFilter = (groupId) => ({
    $or: [{ executorGroupId: groupId }, { managerGroupId: groupId }]
});

const taskOwnershipFilter = (executor) => {
    const employeeId = stringId(executor?._id);
    const group = executor?.groupId || {};
    const groupId = stringId(group);
    const base = taskGroupFilter(groupId);

    if (executor?.role === 'manager') {
        return base;
    }

    // An accepted task must remain private to the executor that accepted it.
    // Some legacy rows only retained assignedExecutorId, so support both
    // fields while never exposing another executor's active task.
    const acceptedByCurrentExecutor = {
        $or: [
            { status: 'accepted', operatorId: employeeId },
            { status: 'accepted', assignedExecutorId: employeeId }
        ]
    };

    if (!group.manualTaskRoutingEnabled) {
        return {
            $and: [
                base,
                {
                    $or: [
                        acceptedByCurrentExecutor,
                        {
                            status: { $in: ACCEPTABLE_TASK_STATUSES },
                            $or: [
                                { assignedExecutorId: { $exists: false } },
                                { assignedExecutorId: null },
                                { assignedExecutorId: employeeId }
                            ]
                        }
                    ]
                }
            ]
        };
    }

    return {
        $and: [
            base,
            {
                $or: [
                    acceptedByCurrentExecutor,
                    { status: { $in: ACCEPTABLE_TASK_STATUSES }, assignedExecutorId: employeeId }
                ]
            }
        ]
    };
};

const busyTaskFilter = (employeeId, tenantId) => {
    const filter = { status: 'accepted', operatorId: String(employeeId) };
    if (tenantId) filter.tenantId = tenantId;
    return filter;
};

const assignmentEligibilityFilter = (employeeId) => ({
    $or: [
        { assignedExecutorId: { $exists: false } },
        { assignedExecutorId: null },
        { assignedExecutorId: String(employeeId) }
    ]
});

const taskTenantMatches = (transaction, tenantScope) => {
    if (!tenantScope) return true;
    const currentTenant = transaction?.tenantId;
    if (tenantScope && typeof tenantScope === 'object' && Array.isArray(tenantScope.$in)) {
        return tenantScope.$in.some((allowedTenant) => (
            allowedTenant === null
                ? currentTenant === null || currentTenant === undefined
                : stringId(currentTenant) === stringId(allowedTenant)
        ));
    }
    return stringId(currentTenant) === stringId(tenantScope);
};

const taskBelongsToGroup = (transaction, groupId) => (
    stringId(transaction?.executorGroupId) === stringId(groupId)
    || stringId(transaction?.managerGroupId) === stringId(groupId)
);

const loadUnavailableTask = async (transactionId) => {
    const lookup = Transaction.findOne({ _id: transactionId });
    return typeof lookup?.lean === 'function' ? lookup.lean() : lookup;
};

const classifyUnavailableTask = ({ transaction, employeeId, groupId, tenantId }) => {
    if (!transaction) return { code: 'TASK_NOT_FOUND' };
    if (!taskTenantMatches(transaction, tenantId)) return { code: 'TASK_TENANT_MISMATCH' };
    if (!taskBelongsToGroup(transaction, groupId)) return { code: 'TASK_GROUP_MISMATCH' };

    if (transaction.status === 'accepted') {
        // Older accepted rows may only have assignedExecutorId. Treat either
        // persisted ownership field as the same executor's replay.
        const operatorId = stringId(transaction.operatorId);
        const assignedExecutorId = stringId(transaction.assignedExecutorId);
        const ownedByCurrentExecutor = (
            (!operatorId || operatorId === stringId(employeeId))
            && (!assignedExecutorId || assignedExecutorId === stringId(employeeId))
            && (operatorId === stringId(employeeId) || assignedExecutorId === stringId(employeeId))
        );
        if (ownedByCurrentExecutor) {
            return { code: 'TASK_ACCEPT_REPLAY', ok: true, replayed: true, transaction };
        }
        return {
            code: 'TASK_TAKEN',
            acceptedByName: transaction.executorName || transaction.assignedExecutorName || null
        };
    }

    if (!ACCEPTABLE_TASK_STATUSES.includes(transaction.status)) {
        return { code: 'TASK_STATE_CHANGED', currentStatus: transaction.status || null };
    }
    if (
        transaction.assignedExecutorId
        && stringId(transaction.assignedExecutorId) !== stringId(employeeId)
    ) {
        return {
            code: 'TASK_ASSIGNED_TO_OTHER',
            assignedExecutorName: transaction.assignedExecutorName || null
        };
    }
    return { code: 'TASK_UNAVAILABLE' };
};

const acceptExecutorTask = async ({ transactionId, executor, tenantId = null }) => {
    const employeeId = stringId(executor?._id);
    const group = executor?.groupId || {};
    const groupId = stringId(group);
    if (!employeeId || !groupId) return { ok: false, code: 'INVALID_EXECUTOR' };

    if (group.manualTaskRoutingEnabled && executor.role === 'manager') {
        return { ok: false, code: 'ROUTING_REQUIRED' };
    }

    let lock = null;
    try {
        lock = await acquireLock(`executor-active-task:${employeeId}`, 10000, { retryCount: 1 });

        // A timeout or duplicate tap can cause the same accept request to be
        // sent again after the first request already succeeded. Treat that
        // exact state as a replay instead of showing a false failure.
        const existingTask = await loadUnavailableTask(transactionId);
        const replay = classifyUnavailableTask({
            transaction: existingTask,
            employeeId,
            groupId,
            tenantId
        });
        if (replay.ok === true) return replay;

        if (await Transaction.exists(busyTaskFilter(employeeId, tenantId))) {
            return { ok: false, code: 'ACTIVE_TASK_EXISTS' };
        }

        const query = {
            _id: transactionId,
            status: { $in: ACCEPTABLE_TASK_STATUSES },
            $and: [taskGroupFilter(groupId), assignmentEligibilityFilter(employeeId)]
        };
        if (tenantId) query.tenantId = tenantId;

        const transaction = await Transaction.findOneAndUpdate(
            query,
            {
                $set: {
                    status: 'accepted',
                    operatorId: employeeId,
                    executorName: executor.name,
                    assignedExecutorId: employeeId,
                    assignedExecutorName: executor.name,
                    emergencyAlert: undefined
                }
            },
            { new: true }
        );

        if (transaction) {
            eventBus.publish('executor:task-accepted', { transactionId, tx: transaction, employee: executor });
            return { ok: true, transaction };
        }

        const currentTask = await loadUnavailableTask(transactionId);
        return {
            ok: false,
            ...classifyUnavailableTask({
                transaction: currentTask,
                employeeId,
                groupId,
                tenantId
            })
        };
    } finally {
        await releaseLock(lock);
    }
};

const listRouteCandidates = async ({ groupId, tenantId = null }) => {
    const query = { groupId, status: 'active', role: 'operator' };
    if (tenantId) query.tenantId = tenantId;
    return Employee.find(query)
        .select('name phone webUsername role')
        .sort({ name: 1 })
        .lean();
};

const routeExecutorTask = async ({ transactionId, manager, employeeId, tenantId = null }) => {
    const group = manager?.groupId || {};
    const groupId = stringId(group);
    if (!groupId || manager?.role !== 'manager') return { ok: false, code: 'FORBIDDEN' };
    if (!group.manualTaskRoutingEnabled) return { ok: false, code: 'ROUTING_DISABLED' };

    const employeeQuery = { _id: employeeId, groupId, status: 'active', role: 'operator' };
    if (tenantId) employeeQuery.tenantId = tenantId;
    const employee = await Employee.findOne(employeeQuery);
    if (!employee) return { ok: false, code: 'INVALID_OPERATOR' };

    let lock = null;
    try {
        lock = await acquireLock(`executor-active-task:${employee._id}`, 10000, { retryCount: 1 });
        if (await Transaction.exists(busyTaskFilter(employee._id, tenantId))) {
            return { ok: false, code: 'ACTIVE_TASK_EXISTS' };
        }

        const taskQuery = {
            _id: transactionId,
            status: { $in: ACCEPTABLE_TASK_STATUSES },
            ...taskGroupFilter(groupId)
        };
        if (tenantId) taskQuery.tenantId = tenantId;
        const transaction = await Transaction.findOneAndUpdate(
            taskQuery,
            {
                $set: {
                    assignedExecutorId: String(employee._id),
                    assignedExecutorName: employee.name,
                    assignedExecutorAt: new Date(),
                    emergencyAlert: undefined
                }
            },
            { new: true }
        );

        if (transaction) {
            eventBus.publish('executor:task-routed', { transactionId, tx: transaction, employee, manager });
            return { ok: true, transaction, employee };
        }
        return { ok: false, code: 'TASK_UNAVAILABLE' };
    } finally {
        await releaseLock(lock);
    }
};

const routingErrorMessage = (code) => {
    const messages = {
        ACTIVE_TASK_EXISTS: 'أكمل أو ألغِ العملية الحالية قبل قبول أو توجيه عملية أخرى.',
        ROUTING_REQUIRED: 'التوجيه اليدوي مفعل. وجّه العملية إلى موظف التنفيذ أولاً.',
        ROUTING_DISABLED: 'فعّل التوجيه اليدوي من لوحة المدير أولاً.',
        INVALID_OPERATOR: 'الموظف المختار غير متاح ضمن فريق التنفيذ.',
        TASK_UNAVAILABLE: 'العملية لم تعد متاحة أو تم سحبها من القائمة.',
        TASK_NOT_FOUND: 'لم تعد العملية موجودة في النظام. حدّث قائمة المهام.',
        TASK_TENANT_MISMATCH: 'العملية لا تتبع حساب شركة التنفيذ الحالي.',
        TASK_GROUP_MISMATCH: 'العملية لم تعد ضمن مجموعة التنفيذ الحالية.',
        TASK_TAKEN: 'تم قبول العملية بالفعل من منفذ آخر.',
        TASK_ASSIGNED_TO_OTHER: 'تم توجيه العملية إلى منفذ آخر.',
        TASK_STATE_CHANGED: 'تغيرت حالة العملية قبل قبولها. حدّث قائمة المهام.',
        INVALID_EXECUTOR: 'حساب المنفذ غير مرتبط بمجموعة تنفيذ صالحة.',
        FORBIDDEN: 'هذه العملية متاحة لمدير التنفيذ فقط.'
    };
    return messages[code] || 'تعذر تنفيذ طلب المهمة.';
};

module.exports = {
    stringId,
    executorIdentityKeys,
    isTaskOwnedByExecutor,
    taskGroupFilter,
    taskOwnershipFilter,
    ACCEPTABLE_TASK_STATUSES,
    acceptExecutorTask,
    listRouteCandidates,
    routeExecutorTask,
    routingErrorMessage
};
