'use strict';

const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const MobileNotificationInbox = require('../models/MobileNotificationInbox');
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
const { DEFAULT_PREFERENCES, definitionFor } = require('../utils/executorNotificationCatalog');
const { taskRecipientPrefix } = require('../utils/executorTaskPrivacy');
const { sendExecutorWebPush } = require('./executorWebPushService');
const logger = require('../utils/logger');

const WORKER_INTERVAL_MS = Math.max(1000, Number(process.env.FCM_WORKER_INTERVAL_MS || 3000));
const REMINDER_INTERVAL_MS = Math.max(30000, Number(process.env.EXECUTOR_PUSH_REMINDER_INTERVAL_MS || 60000));
const MAX_REMINDERS = Math.max(0, Math.min(60, Number(process.env.EXECUTOR_PUSH_MAX_REMINDERS || 60)));
const DEVICE_ACTIVE_DAYS = Math.max(7, Number(process.env.FCM_DEVICE_ACTIVE_DAYS || 90));
const STALE_LOCK_MS = 5 * 60 * 1000;
const LOW_BALANCE_THRESHOLD = Math.max(0, Number(process.env.EXECUTOR_LOW_BALANCE_THRESHOLD || 1000));

const TASK_ACTION_CATEGORIES = new Set([
    'executor_task_new',
    'executor_task_routed',
    'executor_task_reminder',
    'executor_urgent_alert',
    'executor_task_claimed',
    'executor_task_closed'
]);
const INBOX_CATEGORIES = new Set([
    'executor_task_new',
    'executor_task_routed',
    'executor_task_reminder',
    'executor_urgent_alert',
    'executor_task_accepted',
    'executor_task_completed',
    'executor_task_cancelled',
    'executor_support_reply',
    'executor_balance_warning',
    'executor_security_alert',
    'executor_report_ready'
]);

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
    const number = taskRecipientPrefix(recipientNumber(tx)) || 'غير محدد';
    const amount = formatAmount(tx?.amount);
    return {
        title: reminder ? 'طلب تنفيذ ما زال بانتظارك' : 'وصل طلب تنفيذ جديد',
        body: `${service} | ${number} | ${amount}`
    };
};

const queueOutboxEvent = async (payload) => {
    const definition = definitionFor(payload.category);
    const normalized = {
        channelId: definition.channelId,
        sound: definition.sound,
        priority: definition.priority,
        route: definition.route,
        ...payload,
        data: {
            category: payload.category,
            route: payload.route || definition.route,
            priority: payload.priority || definition.priority,
            ...payload.data
        }
    };
    try {
        return await PushNotificationOutbox.findOneAndUpdate(
            { eventKey: normalized.eventKey },
            { $setOnInsert: normalized },
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
        collapseKey: `executor-task-${idOf(tx)}`,
        availableAt: new Date()
    });
};

const statusAudience = (tx) => ({
    type: 'group_roles',
    groupId: idOf(tx?.executorGroupId || tx?.managerGroupId),
    roles: ['manager', 'accountant'],
    includeEmployeeIds: [idOf(tx?.operatorId || tx?.assignedExecutorId)].filter(Boolean)
});

const queueTaskAccepted = async (tx) => {
    await queueTaskNotificationCleanup(tx, 'executor_task_claimed', 'cancel_executor_task_notification');
    const groupId = idOf(tx?.executorGroupId || tx?.managerGroupId);
    if (!groupId) return null;
    const acceptedBy = String(tx?.executorName || tx?.assignedExecutorName || 'أحد المنفذين');
    return queueOutboxEvent({
        eventKey: `executor-task:${idOf(tx)}:accepted:${eventTime(tx?.acceptedAt || tx?.updatedAt)}`,
        category: 'executor_task_accepted',
        transactionId: tx._id,
        audience: statusAudience(tx),
        title: 'تم استلام العملية',
        body: `${acceptedBy} بدأ تنفيذ العملية ${tx.customId || ''}`.trim(),
        data: {
            action: 'open_executor_task',
            transactionId: idOf(tx),
            customId: String(tx.customId || ''),
            status: String(tx.status || 'accepted'),
            acceptedBy
        },
        visible: true,
        collapseKey: `executor-task-status-${idOf(tx)}`,
        availableAt: new Date()
    });
};

const queueTaskResult = async (tx, { cancelled = false, reason = '' } = {}) => {
    await queueTaskNotificationCleanup(tx, 'executor_task_closed', 'cancel_executor_task_notification');
    const groupId = idOf(tx?.executorGroupId || tx?.managerGroupId);
    if (!groupId) return null;
    const category = cancelled ? 'executor_task_cancelled' : 'executor_task_completed';
    const title = cancelled ? 'تم إلغاء عملية التنفيذ' : 'تم تنفيذ العملية بنجاح';
    const body = cancelled
        ? `العملية ${tx.customId || ''} ملغاة${reason ? `: ${reason}` : ''}`
        : `اكتملت العملية ${tx.customId || ''} بقيمة ${formatAmount(tx.amount)} ج.م`;
    return queueOutboxEvent({
        eventKey: `executor-task:${idOf(tx)}:${cancelled ? 'cancelled' : 'completed'}:${eventTime(tx?.cancelledAt || tx?.completedAt || tx?.updatedAt)}`,
        category,
        transactionId: tx._id,
        audience: statusAudience(tx),
        title,
        body,
        data: {
            action: 'open_executor_report',
            transactionId: idOf(tx),
            customId: String(tx.customId || ''),
            status: String(tx.status || (cancelled ? 'cancelled' : 'success')),
            reason: String(reason || '')
        },
        visible: true,
        collapseKey: `executor-task-result-${idOf(tx)}`,
        availableAt: new Date()
    });
};

const queueTaskClosed = (tx) => queueTaskNotificationCleanup(
    tx,
    'executor_task_closed',
    'cancel_executor_task_notification'
);

const queueUrgentAlert = async ({ tx, message }) => {
    if (!tx?._id || !['processing', 'accepted'].includes(tx.status)) return null;
    const groupId = idOf(tx.executorGroupId || tx.managerGroupId);
    if (!groupId) return null;
    const ownerId = idOf(tx.operatorId || tx.assignedExecutorId);
    return queueOutboxEvent({
        eventKey: `executor-task:${idOf(tx)}:urgent:${eventTime(tx.updatedAt)}`,
        category: 'executor_urgent_alert',
        transactionId: tx._id,
        audience: ownerId
            ? { type: 'employee_ids', employeeIds: [ownerId] }
            : { type: 'task_group', groupId },
        title: 'إنذار عاجل من الإدارة',
        body: String(message || tx.emergencyAlert || 'العملية تحتاج إلى تدخل فوري.').slice(0, 600),
        data: {
            action: 'open_executor_task',
            transactionId: idOf(tx),
            customId: String(tx.customId || ''),
            status: String(tx.status || ''),
            urgent: 'true'
        },
        visible: true,
        collapseKey: `executor-urgent-${idOf(tx)}`,
        availableAt: new Date()
    });
};

const queueSupportReply = ({ employeeId, ticketId, message = '' }) => queueOutboxEvent({
    eventKey: `executor-support:${ticketId}:${employeeId}:${Date.now()}`,
    category: 'executor_support_reply',
    referenceId: String(ticketId || ''),
    audience: { type: 'employee_ids', employeeIds: [idOf(employeeId)] },
    title: 'رد جديد من الدعم الفني',
    body: String(message || 'لديك رد جديد داخل محادثة الدعم.').slice(0, 600),
    data: {
        action: 'open_executor_support',
        ticketId: String(ticketId || '')
    },
    visible: true,
    collapseKey: `executor-support-${ticketId}`,
    availableAt: new Date()
});

const queueSecurityAlert = ({ employeeId, deviceName = '', ipAddress = '', occurredAt = new Date() }) => queueOutboxEvent({
    eventKey: `executor-security:${employeeId}:${eventTime(occurredAt)}`,
    category: 'executor_security_alert',
    referenceId: idOf(employeeId),
    audience: { type: 'employee_ids', employeeIds: [idOf(employeeId)] },
    title: 'تسجيل دخول جديد إلى حسابك',
    body: `${deviceName || 'جهاز جديد'}${ipAddress ? ` | ${ipAddress}` : ''}`,
    data: { action: 'open_executor_settings', occurredAt: new Date(occurredAt).toISOString() },
    visible: true,
    collapseKey: `executor-security-${idOf(employeeId)}`,
    availableAt: new Date()
});

const queueReportReady = ({ employeeId, dateType, dateValue }) => queueOutboxEvent({
    eventKey: `executor-report:${employeeId}:${dateType}:${dateValue}:${Date.now()}`,
    category: 'executor_report_ready',
    referenceId: `${dateType}:${dateValue}`,
    audience: { type: 'employee_ids', employeeIds: [idOf(employeeId)] },
    title: 'تقرير التنفيذ جاهز',
    body: `تم تجهيز تقرير ${dateType === 'month' ? 'الشهر' : 'اليوم'} ${dateValue}.`,
    data: { action: 'open_executor_report', dateType: String(dateType), dateValue: String(dateValue) },
    visible: true,
    collapseKey: `executor-report-${idOf(employeeId)}`,
    availableAt: new Date()
});

const queueBalanceWarningForTransaction = async (tx) => {
    const groupId = idOf(tx?.executorGroupId || tx?.managerGroupId);
    if (!groupId || LOW_BALANCE_THRESHOLD <= 0) return null;
    const group = await ExecutorGroup.findById(groupId).select('name balance').lean();
    if (!group || Number(group.balance) > LOW_BALANCE_THRESHOLD) return null;
    const sixHourWindow = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
    return queueOutboxEvent({
        eventKey: `executor-balance:${groupId}:${sixHourWindow}`,
        category: 'executor_balance_warning',
        referenceId: groupId,
        audience: { type: 'group_roles', groupId, roles: ['manager', 'accountant'] },
        title: 'تنبيه انخفاض رصيد التنفيذ',
        body: `رصيد ${group.name || 'شركة التنفيذ'} أصبح ${formatAmount(group.balance)} ج.م.`,
        data: { action: 'open_executor_settings', balance: String(Number(group.balance || 0)) },
        visible: true,
        collapseKey: `executor-balance-${groupId}`,
        availableAt: new Date()
    });
};

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
            $setOnInsert: { notificationPreferences: { ...DEFAULT_PREFERENCES } },
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
    }).select('platform enabled permissionStatus lastSeenAt lastSuccessfulPushAt lastFailureAt lastErrorCode lastErrorMessage notificationPreferences lastOpenedPushAt').lean();
    return {
        firebase: getFirebasePushStatus(),
        device: device ? {
            ...device,
            notificationPreferences: { ...DEFAULT_PREFERENCES, ...(device.notificationPreferences || {}) }
        } : null
    };
};

const sendMobilePushTest = async ({ user, installationId, category = 'executor_task_new' }) => {
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
    const definition = definitionFor(category);
    const result = await sendPushToTokens({
        tokens: [device.token],
        title: 'اختبار إشعارات Ahram Pay',
        body: `قناة ${category} تعمل بنجاح على هذا الهاتف.`,
        data: {
            action: 'push_test',
            category,
            route: definition.route,
            priority: definition.priority,
            sentAt: new Date().toISOString()
        },
        visible: true,
        channelId: definition.channelId,
        sound: definition.sound,
        collapseKey: `push-test-${idOf(user.userId)}-${category}`,
        androidDataOnly: true
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
            $set: { lastSeenAt: new Date(), lastOpenedPushAt: new Date() },
            $pull: { snoozedTasks: { transactionId: taskId } },
            $push: {
                acknowledgedTasks: {
                    $each: [{ transactionId: taskId, acknowledgedAt: new Date() }],
                    $slice: -100
                }
            }
        }
    );
    await MobileNotificationInbox.updateMany(
        { accountId: idOf(user.userId), transactionId: taskId, readAt: null },
        { $set: { readAt: new Date(), openedAt: new Date() } }
    ).catch(() => {});
    return result.modifiedCount > 0;
};

const snoozeMobilePushTask = async ({ user, installationId, transactionId, minutes = 5 }) => {
    const deviceFilter = {
        installationId: String(installationId || '').trim(),
        accountId: idOf(user.userId),
        accountType: user.accountType
    };
    const taskId = String(transactionId || '').trim();
    if (!deviceFilter.installationId || !taskId) return false;
    const mutedUntil = new Date(Date.now() + (Math.max(1, Math.min(30, Number(minutes) || 5)) * 60 * 1000));
    await MobilePushDevice.updateOne(deviceFilter, { $pull: { snoozedTasks: { transactionId: taskId } } });
    const result = await MobilePushDevice.updateOne(deviceFilter, {
        $set: { lastSeenAt: new Date() },
        $push: {
            snoozedTasks: {
                $each: [{ transactionId: taskId, mutedUntil }],
                $slice: -100
            }
        }
    });
    return { updated: result.modifiedCount > 0, mutedUntil };
};

const updateMobilePushPreferences = async ({ user, installationId, preferences = {} }) => {
    const allowed = Object.keys(DEFAULT_PREFERENCES);
    const normalized = Object.fromEntries(allowed
        .filter((key) => Object.prototype.hasOwnProperty.call(preferences, key))
        .map((key) => [key, Boolean(preferences[key])]));
    // Urgent task delivery is operationally mandatory; the user can still change
    // its sound and visibility from Android's channel settings.
    normalized.tasks = true;
    normalized.urgent = true;
    const set = Object.fromEntries(Object.entries(normalized).map(([key, value]) => [
        `notificationPreferences.${key}`,
        value
    ]));
    const device = await MobilePushDevice.findOneAndUpdate(
        {
            installationId: String(installationId || '').trim(),
            accountId: idOf(user.userId),
            accountType: user.accountType
        },
        { $set: { ...set, lastSeenAt: new Date() } },
        { new: true }
    ).select('notificationPreferences').lean();
    return { ...DEFAULT_PREFERENCES, ...(device?.notificationPreferences || {}) };
};

const listMobileNotificationInbox = async ({ user, category, unreadOnly = false, page = 1, limit = 30 }) => {
    const query = { accountType: 'executor', accountId: idOf(user.userId) };
    if (category) query.category = String(category);
    if (unreadOnly) query.readAt = null;
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const safePage = Math.max(1, Number(page) || 1);
    const [items, total, unread] = await Promise.all([
        MobileNotificationInbox.find(query)
            .sort({ createdAt: -1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit)
            .lean(),
        MobileNotificationInbox.countDocuments(query),
        MobileNotificationInbox.countDocuments({ accountType: 'executor', accountId: idOf(user.userId), readAt: null })
    ]);
    return { items, total, unread, page: safePage, limit: safeLimit };
};

const markMobileNotificationRead = async ({ user, notificationId }) => {
    return MobileNotificationInbox.findOneAndUpdate(
        { _id: notificationId, accountType: 'executor', accountId: idOf(user.userId) },
        { $set: { readAt: new Date(), openedAt: new Date() } },
        { new: true }
    ).lean();
};

const markAllMobileNotificationsRead = ({ user }) => MobileNotificationInbox.updateMany(
    { accountType: 'executor', accountId: idOf(user.userId), readAt: null },
    { $set: { readAt: new Date() } }
);

const actionableTask = (outbox, tx) => {
    if (!TASK_ACTION_CATEGORIES.has(outbox.category)) return true;
    if (!tx) return false;
    if (['executor_task_new', 'executor_task_routed', 'executor_task_reminder'].includes(outbox.category)) {
        if (tx.status !== 'processing') return false;
        if (outbox.category === 'executor_task_routed') {
            const expected = String(outbox.audience?.employeeIds?.[0] || '');
            return !expected || String(tx.assignedExecutorId || '') === expected;
        }
    }
    if (outbox.category === 'executor_urgent_alert') {
        return ['processing', 'accepted'].includes(tx.status);
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
    const roles = audience.type === 'group_all'
        ? ['manager', 'operator', 'accountant']
        : (audience.type === 'group_roles' && Array.isArray(audience.roles)
            ? audience.roles.filter((role) => ['manager', 'operator', 'accountant'].includes(role))
            : ['manager', 'operator']);
    const employees = await Employee.find({
        groupId,
        status: 'active',
        role: { $in: roles.length > 0 ? roles : ['manager', 'operator'] }
    }).select('_id role').lean();

    const included = (audience.includeEmployeeIds || []).map(String).filter(Boolean);
    if (audience.type === 'group_all' || audience.type === 'group_roles') {
        return [...new Set([...employees.map((employee) => idOf(employee)), ...included])];
    }

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

const resolveAudienceDevices = async (outbox, tx, resolvedEmployeeIds = null) => {
    const employeeIds = resolvedEmployeeIds || await resolveAudienceEmployeeIds(outbox, tx);
    if (employeeIds.length === 0) return [];
    const cutoff = new Date(Date.now() - (DEVICE_ACTIVE_DAYS * 24 * 60 * 60 * 1000));
    const devices = await MobilePushDevice.find({
        accountType: 'executor',
        accountId: { $in: employeeIds },
        enabled: true,
        permissionStatus: { $in: ['authorized', 'provisional'] },
        lastSeenAt: { $gte: cutoff }
    }).select('_id token accountId acknowledgedTasks snoozedTasks notificationPreferences').lean();
    const definition = definitionFor(outbox.category);
    const preferenceFiltered = devices.filter((device) => {
        if (['executor_task_new', 'executor_task_routed', 'executor_urgent_alert'].includes(outbox.category)) return true;
        const preferences = { ...DEFAULT_PREFERENCES, ...(device.notificationPreferences || {}) };
        return preferences[definition.preferenceKey] !== false;
    });
    if (outbox.category !== 'executor_task_reminder') return preferenceFiltered;
    const transactionId = idOf(tx);
    const now = Date.now();
    return preferenceFiltered.filter((device) => {
        const opened = (device.acknowledgedTasks || []).some(
            (item) => String(item.transactionId || '') === transactionId
        );
        const snoozed = (device.snoozedTasks || []).some((item) => (
            String(item.transactionId || '') === transactionId
            && new Date(item.mutedUntil).getTime() > now
        ));
        return !opened && !snoozed;
    });
};

const recordInboxEntries = async (outbox, employeeIds, deliveryStatus = 'recorded', deliveredAt = null) => {
    if (!INBOX_CATEGORIES.has(outbox.category) || !outbox.visible || !outbox.title) return;
    await Promise.all(employeeIds.map((accountId) => MobileNotificationInbox.findOneAndUpdate(
        { eventKey: outbox.eventKey, accountId: String(accountId) },
        {
            $setOnInsert: {
                eventKey: outbox.eventKey,
                accountType: 'executor',
                accountId: String(accountId),
                category: outbox.category,
                priority: outbox.priority || definitionFor(outbox.category).priority,
                title: outbox.title,
                body: outbox.body || '',
                route: outbox.route || definitionFor(outbox.category).route,
                referenceId: outbox.referenceId || '',
                transactionId: outbox.transactionId || null,
                data: outbox.data || {}
            },
            $set: { deliveryStatus, ...(deliveredAt ? { deliveredAt } : {}) }
        },
        { upsert: true, new: true }
    ).catch((error) => logger.error('Failed to record executor notification inbox item', {
        eventKey: outbox.eventKey,
        accountId,
        error: error.message
    }))));
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
    const recurringTaskCategories = ['executor_task_new', 'executor_task_routed', 'executor_task_reminder'];
    if (
        !tx
        || !outbox.visible
        || !recurringTaskCategories.includes(outbox.category)
        || outbox.reminderSequence >= MAX_REMINDERS
        || tx.status !== 'processing'
    ) return;
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
        collapseKey: outbox.collapseKey,
        reminderSequence: nextSequence,
        availableAt: new Date(Date.now() + REMINDER_INTERVAL_MS)
    });
};

const executorPortalUrlForNotification = (outbox) => {
    const category = String(outbox?.category || '');
    if (category === 'executor_support_reply') return '/executor-portal/support';
    if (['executor_report_ready', 'executor_task_completed', 'executor_task_cancelled'].includes(category)) {
        return '/executor-portal/reports';
    }
    if (['executor_balance_warning', 'executor_security_alert'].includes(category)) return '/executor-portal/settings';
    return '/executor-portal/dashboard';
};

const processOutboxItem = async (outbox) => {
    const tx = outbox.transactionId ? await Transaction.findById(outbox.transactionId).lean() : null;
    if (!actionableTask(outbox, tx)) {
        await PushNotificationOutbox.updateOne(
            { _id: outbox._id },
            { $set: { status: 'cancelled', processedAt: new Date(), lastErrorCode: 'TASK_NOT_ACTIONABLE' } }
        );
        return { status: 'cancelled' };
    }

    const employeeIds = await resolveAudienceEmployeeIds(outbox, tx);
    const devices = await resolveAudienceDevices(outbox, tx, employeeIds);
    const notificationData = {
        ...outbox.data,
        category: outbox.category,
        route: outbox.route || definitionFor(outbox.category).route,
        url: outbox.route || definitionFor(outbox.category).route || '/executor-portal/dashboard',
        priority: outbox.priority || definitionFor(outbox.category).priority,
        referenceId: String(outbox.referenceId || '')
    };
    const mobileResult = devices.length > 0
        ? await sendPushToTokens({
            tokens: devices.map((device) => device.token),
            title: outbox.title,
            body: outbox.body,
            data: notificationData,
            visible: outbox.visible,
            channelId: outbox.channelId,
            sound: outbox.sound,
            collapseKey: outbox.collapseKey,
            androidDataOnly: outbox.visible
        })
        : { successCount: 0, failureCount: 0, responses: [] };
    if (devices.length > 0) await updateDeviceDeliveryResults(devices, mobileResult.responses);

    let browserResult;
    try {
        browserResult = await sendExecutorWebPush({
            employeeIds,
            title: outbox.title,
            body: outbox.body,
            category: outbox.category,
            data: { ...notificationData, url: executorPortalUrlForNotification(outbox) },
            collapseKey: outbox.collapseKey,
            urgency: notificationData.priority === 'urgent' ? 'high' : 'normal',
            ttl: Math.max(120, Math.ceil(REMINDER_INTERVAL_MS / 1000) + 60)
        });
    } catch (error) {
        browserResult = { configured: true, attempted: 0, sent: 0, failed: 0, error: error.message };
        logger.error('Executor browser push delivery failed without blocking mobile push', {
            eventKey: outbox.eventKey,
            error: error.message
        });
    }
    const attemptedCount = devices.length + Number(browserResult.attempted || 0);
    const successCount = Number(mobileResult.successCount || 0) + Number(browserResult.sent || 0);
    const failureCount = Number(mobileResult.failureCount || 0) + Number(browserResult.failed || 0);

    if (attemptedCount === 0) {
        await recordInboxEntries(outbox, employeeIds, 'skipped');
        await PushNotificationOutbox.updateOne(
            { _id: outbox._id },
            { $set: { status: 'skipped', processedAt: new Date(), lastErrorCode: 'NO_ELIGIBLE_DEVICES' } }
        );
        return { status: 'skipped', browser: browserResult };
    }

    if (successCount === 0 && failureCount > 0) {
        await recordInboxEntries(outbox, employeeIds, 'failed');
        const error = new Error('Every mobile and browser push delivery failed');
        error.code = 'ALL_PUSH_DELIVERIES_FAILED';
        throw error;
    }
    await PushNotificationOutbox.updateOne(
        { _id: outbox._id },
        {
            $set: {
                status: successCount > 0 ? 'sent' : 'failed',
                processedAt: new Date(),
                sentCount: successCount,
                failedCount: failureCount,
                lastErrorCode: successCount > 0 ? '' : 'ALL_PUSH_DELIVERIES_FAILED'
            }
        }
    );
    await recordInboxEntries(
        outbox,
        employeeIds,
        successCount > 0 ? 'accepted' : 'failed',
        successCount > 0 ? new Date() : null
    );
    if (successCount > 0) await scheduleNextReminder(outbox, tx);
    return {
        status: successCount > 0 ? 'sent' : 'failed',
        successCount,
        failureCount,
        mobile: mobileResult,
        browser: browserResult
    };
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
        queueTaskAccepted(tx).catch((error) => logger.error('Failed to queue accepted task push', { error: error.message }));
    });
    eventBus.on('executor:urgent-alert', ({ tx, message }) => {
        queueUrgentAlert({ tx, message }).catch((error) => logger.error('Failed to queue urgent executor push', { error: error.message }));
    });
    eventBus.on('executor:support-reply', (payload) => {
        queueSupportReply(payload).catch((error) => logger.error('Failed to queue executor support push', { error: error.message }));
    });
    eventBus.on('executor:security-alert', (payload) => {
        queueSecurityAlert(payload).catch((error) => logger.error('Failed to queue executor security push', { error: error.message }));
    });
    eventBus.on('executor:report-ready', (payload) => {
        queueReportReady(payload).catch((error) => logger.error('Failed to queue executor report push', { error: error.message }));
    });
    eventBus.on('transfer:created', ({ tx }) => {
        queueTaskAvailable(tx, { source: 'transfer-created' }).catch((error) => logger.error('Failed to queue auto-routed task push', { error: error.message }));
    });
    eventBus.on('transfer:completed', ({ tx }) => {
        queueTaskResult(tx).catch((error) => logger.error('Failed to queue completed task push', { error: error.message }));
        queueBalanceWarningForTransaction(tx).catch((error) => logger.error('Failed to queue executor balance warning', { error: error.message }));
    });
    eventBus.on('transfer:cancelled', ({ tx, reason }) => {
        queueTaskResult(tx, { cancelled: true, reason }).catch((error) => logger.error('Failed to queue cancelled task push', { error: error.message }));
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
    queueTaskResult,
    queueTaskClosed,
    queueUrgentAlert,
    queueSupportReply,
    queueSecurityAlert,
    queueReportReady,
    queueBalanceWarningForTransaction,
    cancelPendingTaskAlerts,
    registerMobilePushDevice,
    unregisterMobilePushDevice,
    getMobilePushDeviceStatus,
    sendMobilePushTest,
    acknowledgeMobilePushTask,
    snoozeMobilePushTask,
    updateMobilePushPreferences,
    listMobileNotificationInbox,
    markMobileNotificationRead,
    markAllMobileNotificationsRead,
    processNextPushNotification,
    processOutboxItem,
    registerExecutorPushEventHandlers,
    startExecutorPushNotificationWorker,
    stopExecutorPushNotificationWorker,
    resolveAudienceEmployeeIds
};
