'use strict';

const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const MobilePushDevice = require('../models/MobilePushDevice');
const PushNotificationOutbox = require('../models/PushNotificationOutbox');
const Transaction = require('../models/Transaction');
const eventBus = require('./eventBus');
const {
    getFirebasePushStatus,
    isInvalidPushTokenError,
    sendPushToTokens
} = require('./firebasePushService');
const { getTransferServiceLabel } = require('../utils/mobileTransferServiceCatalog');
const logger = require('../utils/logger');

const WORKER_INTERVAL_MS = Math.max(1000, Number(process.env.FCM_WORKER_INTERVAL_MS || 3000));
const REMINDER_INTERVAL_MS = Math.max(30000, Number(process.env.EXECUTOR_PUSH_REMINDER_INTERVAL_MS || 60000));
const MAX_REMINDERS = Math.max(0, Math.min(60, Number(process.env.EXECUTOR_PUSH_MAX_REMINDERS || 60)));
const DEVICE_ACTIVE_DAYS = Math.max(7, Number(process.env.FCM_DEVICE_ACTIVE_DAYS || 90));
const STALE_LOCK_MS = 5 * 60 * 1000;

let workerTimer = null;
let handlersRegistered = false;
let workerBusy = false;

const idOf = (value) => String(value?._id || value || '');
const eventTime = (value) => {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
};

const recipientNumber = (tx) => String(
    tx?.vodafoneNumber
    || tx?.accountNumber
    || tx?.serviceDetails?.recipientPhone
    || tx?.serviceDetails?.clientPhone
    || ''
).trim();

const formatAmount = (value) => {
    const amount = Number(value || 0);
    return Number.isInteger(amount)
        ? amount.toLocaleString('en-US')
        : amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

const taskMessage = (tx, reminder = false) => {
    const service = getTransferServiceLabel(tx?.transferType) || 'تحويل مالي';
    const number = recipientNumber(tx) || 'غير محدد';
    const amount = formatAmount(tx?.amount);
    return {
        title: reminder ? 'طلب تنفيذ ما زال بانتظارك' : 'وصل طلب تنفيذ جديد',
        body: `${service} | ${number} | ${amount}`
    };
};

const queueOutboxEvent = async (payload) => {
    try {
        return await PushNotificationOutbox.findOneAndUpdate(
            { eventKey: payload.eventKey },
            { $setOnInsert: payload },
            { upsert: true, new: true }
        );
    } catch (error) {
        if (error?.code === 11000) return null;
        throw error;
    }
};

const queueTaskAvailable = async (tx, { source = 'system' } = {}) => {
    if (!tx || tx.status !== 'processing' || !tx.executorGroupId) return null;
    const group = await ExecutorGroup.findById(tx.executorGroupId)
        .select('_id status isApiBot isApiGroup manualTaskRoutingEnabled')
        .lean();
    if (!group || group.status !== 'active' || group.isApiBot || group.isApiGroup) return null;

    const message = taskMessage(tx, false);
    const cycle = eventTime(tx.executorReceivedAt || tx.updatedAt || tx.createdAt);
    return queueOutboxEvent({
        eventKey: `executor-task:${idOf(tx)}:available:${cycle}`,
        category: 'executor_task_new',
        transactionId: tx._id,
        audience: { type: 'task_group', groupId: idOf(group), source },
        title: message.title,
        body: message.body,
        data: {
            action: 'open_executor_task',
            transactionId: idOf(tx),
            customId: String(tx.customId || ''),
            status: String(tx.status || ''),
            reminder: 'false',
            alertCycle: String(cycle)
        },
        visible: true,
        channelId: 'executor_tasks',
        collapseKey: `executor-task-${idOf(tx)}`,
        reminderSequence: 0,
        availableAt: new Date()
    });
};

const cancelPendingTaskAlerts = (transactionId) => PushNotificationOutbox.updateMany(
    {
        transactionId,
        status: { $in: ['pending', 'processing'] },
        category: { $in: ['executor_task_new', 'executor_task_routed', 'executor_task_reminder'] }
    },
    { $set: { status: 'cancelled', processedAt: new Date(), lastErrorCode: 'TASK_STATE_CHANGED' } }
);

const queueTaskRouted = async (tx, employee) => {
    if (!tx || !employee || tx.status !== 'processing') return null;
    await cancelPendingTaskAlerts(tx._id);
    const message = taskMessage(tx, false);
    const assignedAt = eventTime(tx.assignedExecutorAt || tx.updatedAt);
    return queueOutboxEvent({
        eventKey: `executor-task:${idOf(tx)}:routed:${idOf(employee)}:${assignedAt}`,
        category: 'executor_task_routed',
        transactionId: tx._id,
        audience: { type: 'employee_ids', employeeIds: [idOf(employee)] },
        title: 'تم توجيه عملية إليك',
        body: message.body,
        data: {
            action: 'open_executor_task',
            transactionId: idOf(tx),
            customId: String(tx.customId || ''),
            status: String(tx.status || ''),
            reminder: 'false',
            alertCycle: String(assignedAt)
        },
        visible: true,
        channelId: 'executor_tasks',
        collapseKey: `executor-task-${idOf(tx)}`,
        reminderSequence: 0,
        availableAt: new Date()
    });
};

const queueTaskNotificationCleanup = async (tx, category, action) => {
    if (!tx?._id) return null;
    await cancelPendingTaskAlerts(tx._id);
    const groupId = idOf(tx.executorGroupId || tx.managerGroupId);
    if (!groupId) return null;
    return queueOutboxEvent({
        eventKey: `executor-task:${idOf(tx)}:${category}:${eventTime(tx.updatedAt || tx.completedAt || tx.cancelledAt)}`,
        category,
        transactionId: tx._id,
        audience: { type: 'group_all', groupId },
        data: {
            action,
            transactionId: idOf(tx),
            customId: String(tx.customId || ''),
            status: String(tx.status || '')
        },
        visible: false,
        channelId: 'executor_tasks',
        collapseKey: `executor-task-${idOf(tx)}`,
        availableAt: new Date()
    });
};

const queueTaskAccepted = (tx) => queueTaskNotificationCleanup(
    tx,
    'executor_task_claimed',
    'cancel_executor_task_notification'
);

const queueTaskClosed = (tx) => queueTaskNotificationCleanup(
    tx,
    'executor_task_closed',
    'cancel_executor_task_notification'
);

const registerMobilePushDevice = async ({ user, payload = {} }) => {
    const installationId = String(payload.installationId || '').trim();
    const token = String(payload.token || '').trim();
    if (!installationId || installationId.length > 160) {
        const error = new Error('INVALID_INSTALLATION_ID');
        error.code = 'INVALID_INSTALLATION_ID';
        throw error;
    }
    if (!token || token.length < 20 || token.length > 4096) {
        const error = new Error('INVALID_PUSH_TOKEN');
        error.code = 'INVALID_PUSH_TOKEN';
        throw error;
    }

    let executorGroupId = null;
    let executorRole = '';
    if (user.accountType === 'executor') {
        const employee = await Employee.findById(user.userId).select('groupId role status').lean();
        if (!employee || employee.status !== 'active') {
            const error = new Error('EXECUTOR_NOT_ACTIVE');
            error.code = 'EXECUTOR_NOT_ACTIVE';
            throw error;
        }
        executorGroupId = employee.groupId || user.executorGroupId || null;
        executorRole = employee.role || '';
    }

    await MobilePushDevice.updateMany(
        { token, installationId: { $ne: installationId } },
        { $set: { enabled: false, lastErrorCode: 'TOKEN_MOVED_TO_ANOTHER_INSTALLATION' } }
    );

    return MobilePushDevice.findOneAndUpdate(
        { installationId },
        {
            $set: {
                token,
                accountType: user.accountType,
                accountId: idOf(user.userId),
                executorGroupId,
                executorRole,
                platform: payload.platform === 'ios' ? 'ios' : 'android',
                appVersion: String(payload.appVersion || '').slice(0, 40),
                deviceName: String(payload.deviceName || '').slice(0, 120),
                locale: String(payload.locale || '').slice(0, 20),
                timeZone: String(payload.timeZone || '').slice(0, 80),
                permissionStatus: ['authorized', 'provisional', 'denied', 'not_determined'].includes(payload.permissionStatus)
                    ? payload.permissionStatus
                    : 'not_determined',
                enabled: payload.permissionStatus !== 'denied',
                tokenUpdatedAt: new Date(),
                lastSeenAt: new Date(),
                lastErrorCode: '',
                lastErrorMessage: ''
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const unregisterMobilePushDevice = async ({ user, installationId }) => {
    const result = await MobilePushDevice.updateOne(
        { installationId: String(installationId || '').trim(), accountId: idOf(user.userId), accountType: user.accountType },
        { $set: { enabled: false, lastSeenAt: new Date(), lastErrorCode: 'SIGNED_OUT' } }
    );
    return result.modifiedCount > 0;
};

const getMobilePushDeviceStatus = async ({ user, installationId }) => {
    const device = await MobilePushDevice.findOne({
        installationId: String(installationId || '').trim(),
        accountId: idOf(user.userId),
        accountType: user.accountType
    }).select('platform enabled permissionStatus lastSeenAt lastSuccessfulPushAt lastFailureAt lastErrorCode').lean();
    return { firebase: getFirebasePushStatus(), device: device || null };
};

const sendMobilePushTest = async ({ user, installationId }) => {
    const device = await MobilePushDevice.findOne({
        installationId: String(installationId || '').trim(),
        accountId: idOf(user.userId),
        accountType: user.accountType,
        enabled: true
    }).select('_id token accountId').lean();
    if (!device) {
        const error = new Error('No active push device is registered for this installation');
        error.code = 'PUSH_DEVICE_NOT_REGISTERED';
        throw error;
    }
    const result = await sendPushToTokens({
        tokens: [device.token],
        title: 'اختبار إشعارات Ahram Pay',
        body: 'الإشعارات الفورية تعمل بنجاح على هذا الهاتف.',
        data: { action: 'push_test', sentAt: new Date().toISOString() },
        visible: true,
        channelId: 'executor_tasks',
        collapseKey: `push-test-${idOf(user.userId)}`
    });
    await updateDeviceDeliveryResults([device], result.responses);
    if (result.successCount === 0) {
        const error = new Error('Firebase did not accept the test notification');
        error.code = 'PUSH_TEST_DELIVERY_FAILED';
        throw error;
    }
    return result;
};

const acknowledgeMobilePushTask = async ({ user, installationId, transactionId }) => {
    const deviceFilter = {
        installationId: String(installationId || '').trim(),
        accountId: idOf(user.userId),
        accountType: user.accountType
    };
    const taskId = String(transactionId || '').trim();
    if (!deviceFilter.installationId || !taskId) return false;
    await MobilePushDevice.updateOne(
        deviceFilter,
        { $pull: { acknowledgedTasks: { transactionId: taskId } } }
    );
    const result = await MobilePushDevice.updateOne(
        deviceFilter,
        {
            $set: { lastSeenAt: new Date() },
            $push: {
                acknowledgedTasks: {
                    $each: [{ transactionId: taskId, acknowledgedAt: new Date() }],
                    $slice: -100
                }
            }
        }
    );
    return result.modifiedCount > 0;
};

const actionableTask = (outbox, tx) => {
    if (!tx) return false;
    if (['executor_task_new', 'executor_task_routed', 'executor_task_reminder'].includes(outbox.category)) {
        if (tx.status !== 'processing') return false;
        if (outbox.category === 'executor_task_routed') {
            const expected = String(outbox.audience?.employeeIds?.[0] || '');
            return !expected || String(tx.assignedExecutorId || '') === expected;
        }
    }
    if (outbox.category === 'executor_task_claimed') return tx.status === 'accepted';
    return true;
};

const resolveAudienceEmployeeIds = async (outbox, tx) => {
    const audience = outbox.audience || {};
    if (audience.type === 'employee_ids') {
        return (audience.employeeIds || []).map(String).filter(Boolean);
    }

    const groupId = String(audience.groupId || tx?.executorGroupId || tx?.managerGroupId || '');
    if (!groupId) return [];
    const employees = await Employee.find({
        groupId,
        status: 'active',
        role: { $in: audience.type === 'group_all' ? ['manager', 'operator', 'accountant'] : ['manager', 'operator'] }
    }).select('_id role').lean();

    if (audience.type === 'group_all') return employees.map((employee) => idOf(employee));

    const group = await ExecutorGroup.findById(groupId).select('manualTaskRoutingEnabled').lean();
    const assignedExecutorId = String(tx?.assignedExecutorId || '');
    let eligible = employees;
    if (assignedExecutorId) {
        eligible = employees.filter((employee) => idOf(employee) === assignedExecutorId);
    } else if (group?.manualTaskRoutingEnabled) {
        eligible = employees.filter((employee) => employee.role === 'manager');
    }

    const ids = eligible.map((employee) => idOf(employee));
    if (ids.length === 0) return [];
    const busyIds = await Transaction.distinct('operatorId', {
        status: 'accepted',
        operatorId: { $in: ids }
    });
    const busy = new Set(busyIds.map(String));
    return ids.filter((id) => !busy.has(id));
};

const resolveAudienceDevices = async (outbox, tx) => {
    const employeeIds = await resolveAudienceEmployeeIds(outbox, tx);
    if (employeeIds.length === 0) return [];
    const cutoff = new Date(Date.now() - (DEVICE_ACTIVE_DAYS * 24 * 60 * 60 * 1000));
    const devices = await MobilePushDevice.find({
        accountType: 'executor',
        accountId: { $in: employeeIds },
        enabled: true,
        permissionStatus: { $in: ['authorized', 'provisional'] },
        lastSeenAt: { $gte: cutoff }
    }).select('_id token accountId acknowledgedTasks').lean();
    if (outbox.category !== 'executor_task_reminder') return devices;
    const transactionId = idOf(tx);
    return devices.filter((device) => !(device.acknowledgedTasks || []).some(
        (item) => String(item.transactionId || '') === transactionId
    ));
};

const updateDeviceDeliveryResults = async (devices, responses) => {
    const byToken = new Map(devices.map((device) => [device.token, device]));
    await Promise.all((responses || []).map(async (response) => {
        const device = byToken.get(response.token);
        if (!device) return;
        if (response.success) {
            await MobilePushDevice.updateOne(
                { _id: device._id },
                { $set: { lastSuccessfulPushAt: new Date(), lastErrorCode: '', lastErrorMessage: '' } }
            );
            return;
        }
        const code = response.error?.code || 'FCM_DELIVERY_FAILED';
        await MobilePushDevice.updateOne(
            { _id: device._id },
            {
                $set: {
                    enabled: isInvalidPushTokenError(response.error) ? false : true,
                    lastFailureAt: new Date(),
                    lastErrorCode: code,
                    lastErrorMessage: String(response.error?.message || '').slice(0, 500)
                }
            }
        );
    }));
};

const scheduleNextReminder = async (outbox, tx) => {
    if (!outbox.visible || outbox.reminderSequence >= MAX_REMINDERS || tx.status !== 'processing') return;
    const nextSequence = Number(outbox.reminderSequence || 0) + 1;
    const message = taskMessage(tx, true);
    const alertCycle = String(outbox.data?.alertCycle || eventTime(tx.executorReceivedAt || tx.updatedAt));
    const audienceKey = outbox.audience?.type === 'employee_ids'
        ? String(outbox.audience.employeeIds?.[0] || 'employee')
        : String(outbox.audience?.groupId || 'group');
    await queueOutboxEvent({
        eventKey: `executor-task:${idOf(tx)}:reminder:${alertCycle}:${audienceKey}:${nextSequence}`,
        category: 'executor_task_reminder',
        transactionId: tx._id,
        audience: outbox.audience,
        title: message.title,
        body: message.body,
        data: {
            ...outbox.data,
            action: 'open_executor_task',
            reminder: 'true',
            reminderSequence: String(nextSequence)
        },
        visible: true,
        channelId: outbox.channelId,
        collapseKey: outbox.collapseKey,
        reminderSequence: nextSequence,
        availableAt: new Date(Date.now() + REMINDER_INTERVAL_MS)
    });
};

const processOutboxItem = async (outbox) => {
    const tx = await Transaction.findById(outbox.transactionId).lean();
    if (!actionableTask(outbox, tx)) {
        await PushNotificationOutbox.updateOne(
            { _id: outbox._id },
            { $set: { status: 'cancelled', processedAt: new Date(), lastErrorCode: 'TASK_NOT_ACTIONABLE' } }
        );
        return { status: 'cancelled' };
    }

    const devices = await resolveAudienceDevices(outbox, tx);
    if (devices.length === 0) {
        await PushNotificationOutbox.updateOne(
            { _id: outbox._id },
            { $set: { status: 'skipped', processedAt: new Date(), lastErrorCode: 'NO_ELIGIBLE_DEVICES' } }
        );
        return { status: 'skipped' };
    }

    const result = await sendPushToTokens({
        tokens: devices.map((device) => device.token),
        title: outbox.title,
        body: outbox.body,
        data: outbox.data,
        visible: outbox.visible,
        channelId: outbox.channelId,
        collapseKey: outbox.collapseKey
    });
    await updateDeviceDeliveryResults(devices, result.responses);
    if (result.successCount === 0 && result.failureCount > 0) {
        const error = new Error('Firebase rejected every target device');
        error.code = 'FCM_ALL_DELIVERIES_FAILED';
        throw error;
    }
    await PushNotificationOutbox.updateOne(
        { _id: outbox._id },
        {
            $set: {
                status: result.successCount > 0 ? 'sent' : 'failed',
                processedAt: new Date(),
                sentCount: result.successCount,
                failedCount: result.failureCount,
                lastErrorCode: result.successCount > 0 ? '' : 'FCM_ALL_DELIVERIES_FAILED'
            }
        }
    );
    if (result.successCount > 0) await scheduleNextReminder(outbox, tx);
    return { status: result.successCount > 0 ? 'sent' : 'failed', ...result };
};

const processNextPushNotification = async () => {
    const now = new Date();
    const outbox = await PushNotificationOutbox.findOneAndUpdate(
        { status: 'pending', availableAt: { $lte: now } },
        { $set: { status: 'processing', lockedAt: now }, $inc: { attempts: 1 } },
        { sort: { availableAt: 1, createdAt: 1 }, new: true }
    );
    if (!outbox) return null;

    try {
        return await processOutboxItem(outbox);
    } catch (error) {
        const finalAttempt = outbox.attempts >= outbox.maxAttempts;
        const delay = Math.min(5 * 60 * 1000, 15000 * (2 ** Math.max(0, outbox.attempts - 1)));
        await PushNotificationOutbox.updateOne(
            { _id: outbox._id },
            {
                $set: {
                    status: finalAttempt ? 'failed' : 'pending',
                    availableAt: finalAttempt ? outbox.availableAt : new Date(Date.now() + delay),
                    processedAt: finalAttempt ? new Date() : null,
                    lockedAt: null,
                    lastErrorCode: String(error.code || 'FCM_SEND_FAILED').slice(0, 160),
                    lastErrorMessage: String(error.message || '').slice(0, 800)
                }
            }
        );
        logger.error('Executor push delivery failed', {
            eventKey: outbox.eventKey,
            attempt: outbox.attempts,
            finalAttempt,
            error: error.message
        });
        return { status: finalAttempt ? 'failed' : 'retrying', error: error.message };
    }
};

const runWorkerTick = async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
        for (let index = 0; index < 25; index += 1) {
            const result = await processNextPushNotification();
            if (!result) break;
        }
    } finally {
        workerBusy = false;
    }
};

const registerExecutorPushEventHandlers = () => {
    if (handlersRegistered) return;
    handlersRegistered = true;
    eventBus.on('executor:task-available', ({ tx, source }) => {
        queueTaskAvailable(tx, { source }).catch((error) => logger.error('Failed to queue executor task push', { error: error.message }));
    });
    eventBus.on('executor:task-routed', ({ tx, employee }) => {
        queueTaskRouted(tx, employee).catch((error) => logger.error('Failed to queue routed task push', { error: error.message }));
    });
    eventBus.on('executor:task-accepted', ({ tx }) => {
        queueTaskAccepted(tx).catch((error) => logger.error('Failed to clear accepted task push', { error: error.message }));
    });
    eventBus.on('transfer:created', ({ tx }) => {
        queueTaskAvailable(tx, { source: 'transfer-created' }).catch((error) => logger.error('Failed to queue auto-routed task push', { error: error.message }));
    });
    eventBus.on('transfer:completed', ({ tx }) => {
        queueTaskClosed(tx).catch((error) => logger.error('Failed to close completed task push', { error: error.message }));
    });
    eventBus.on('transfer:cancelled', ({ tx }) => {
        queueTaskClosed(tx).catch((error) => logger.error('Failed to close cancelled task push', { error: error.message }));
    });
    eventBus.on('executor:task-withdrawn', ({ tx }) => {
        queueTaskClosed(tx).catch((error) => logger.error('Failed to close withdrawn task push', { error: error.message }));
    });
};

const startExecutorPushNotificationWorker = async () => {
    registerExecutorPushEventHandlers();
    await PushNotificationOutbox.updateMany(
        { status: 'processing', lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
        { $set: { status: 'pending', lockedAt: null, availableAt: new Date() } }
    );
    if (!workerTimer) {
        workerTimer = setInterval(() => {
            runWorkerTick().catch((error) => logger.error('Executor push worker tick failed', { error: error.message }));
        }, WORKER_INTERVAL_MS);
        workerTimer.unref?.();
    }
    await runWorkerTick();
    logger.info('Executor push notification worker started', {
        intervalMs: WORKER_INTERVAL_MS,
        reminderIntervalMs: REMINDER_INTERVAL_MS,
        maxReminders: MAX_REMINDERS,
        firebase: getFirebasePushStatus()
    });
};

const stopExecutorPushNotificationWorker = () => {
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
};

module.exports = {
    queueTaskAvailable,
    queueTaskRouted,
    queueTaskAccepted,
    queueTaskClosed,
    cancelPendingTaskAlerts,
    registerMobilePushDevice,
    unregisterMobilePushDevice,
    getMobilePushDeviceStatus,
    sendMobilePushTest,
    acknowledgeMobilePushTask,
    processNextPushNotification,
    processOutboxItem,
    registerExecutorPushEventHandlers,
    startExecutorPushNotificationWorker,
    stopExecutorPushNotificationWorker,
    resolveAudienceEmployeeIds
};
