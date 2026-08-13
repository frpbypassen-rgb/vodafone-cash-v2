'use strict';

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { acquireLock, releaseLock } = require('./lockService');

const stringId = (value) => String(value?._id || value || '');

const taskGroupFilter = (groupId) => ({
    $or: [{ executorGroupId: groupId }, { managerGroupId: groupId }]
});

const taskOwnershipFilter = (executor) => {
    const employeeId = stringId(executor?._id);
    const group = executor?.groupId || {};
    const groupId = stringId(group);
    const base = taskGroupFilter(groupId);

    if (executor?.role === 'manager' || !group.manualTaskRoutingEnabled) {
        return base;
    }

    return {
        $and: [
            base,
            {
                $or: [
                    { status: 'accepted' },
                    { status: 'processing', assignedExecutorId: employeeId }
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

        if (await Transaction.exists(busyTaskFilter(employeeId, tenantId))) {
            return { ok: false, code: 'ACTIVE_TASK_EXISTS' };
        }

        const query = {
            _id: transactionId,
            status: 'processing',
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

        return transaction
            ? { ok: true, transaction }
            : { ok: false, code: 'TASK_UNAVAILABLE' };
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
            status: 'processing',
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

        return transaction
            ? { ok: true, transaction, employee }
            : { ok: false, code: 'TASK_UNAVAILABLE' };
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
        INVALID_EXECUTOR: 'حساب المنفذ غير مرتبط بمجموعة تنفيذ صالحة.',
        FORBIDDEN: 'هذه العملية متاحة لمدير التنفيذ فقط.'
    };
    return messages[code] || 'تعذر تنفيذ طلب المهمة.';
};

module.exports = {
    stringId,
    taskGroupFilter,
    taskOwnershipFilter,
    acceptExecutorTask,
    listRouteCandidates,
    routeExecutorTask,
    routingErrorMessage
};
