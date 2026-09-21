'use strict';

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { decrypt, encrypt, hashForLog } = require('../utils/encryption');
const {
    acceptExecutorTask,
    findOwnedAcceptedExecutorTask,
    routingErrorMessage
} = require('./executorTaskRoutingService');
const { invalidateExecutorAuth } = require('./executorAuthCache');
const { readExecutorManualPolicy } = require('../utils/executorManualPolicy');
const {
    PIN_SECURITY_NOTE_AR,
    USSD_NETWORKS,
    buildUssdString,
    networkRequiresPin,
    normalizeUssdNetwork,
    redactUssdForLog,
    sanitizeAmountDigits,
    sanitizePhoneDigits,
    toTelUri,
    toPublicQuickExecuteState,
    validateWalletPin
} = require('../utils/executorQuickExecuteUssd');
const { isCashWalletTask, taskRecipientValue } = require('../utils/executorTaskPrivacy');

const TASK_NOT_ACCEPTED_AR = 'هذه المهمة ليست ضمن مهامك المقبولة. اسحب/اقبل المهمة أولًا ثم استخدم التنفيذ السريع.';
const TASK_NOT_CLAIMABLE_AR = 'هذه المهمة ليست لك أو غير قابلة للسحب. اسحب/اقبل المهمة أولًا إن كانت متاحة لك.';
const ACCEPTABLE_DIAL_STATUSES = new Set(['processing', 'pending']);

class QuickExecuteError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'QuickExecuteError';
        this.code = code;
        this.status = status;
    }
}

const stringId = (value) => String(value?._id || value || '').trim();

const normalizeDialTenantScope = (tenantId) => {
    if (!tenantId) return null;
    if (typeof tenantId === 'object' && Array.isArray(tenantId.$in)) return tenantId;
    return String(process.env.TENANT_MODE || '').trim().toLowerCase() === 'single'
        ? { $in: [tenantId, null] }
        : tenantId;
};

const executorIdentitySet = (employee) => new Set([
    stringId(employee?._id),
    String(employee?.webUsername || '').trim()
].filter(Boolean));

const executorOwnsAcceptedTask = (task, employee) => {
    if (!task || String(task.status || '') !== 'accepted') return false;
    const identities = executorIdentitySet(employee);
    return [task.operatorId, task.assignedExecutorId]
        .map(stringId)
        .some((ownerId) => ownerId && identities.has(ownerId));
};

const taskAssignedToExecutor = (task, employee) => {
    const assignedId = stringId(task?.assignedExecutorId);
    return Boolean(assignedId && executorIdentitySet(employee).has(assignedId));
};

const loadExecutorForQuickExecute = async (executorId, { includePin = false } = {}) => {
    const query = Employee.findById(executorId);
    if (includePin && typeof query.select === 'function') {
        query.select('+ussdWalletPinEncrypted');
    }
    if (typeof query.populate === 'function') {
        query.populate('groupId');
    }
    const employee = await query;
    if (!employee) {
        throw new QuickExecuteError('UNAUTHORIZED', 'تعذر العثور على حساب المنفذ.', 401);
    }
    return employee;
};

const getQuickExecuteState = async ({ executorId }) => {
    const employee = await loadExecutorForQuickExecute(executorId);
    const policy = readExecutorManualPolicy(employee.groupId, employee);
    return toPublicQuickExecuteState(policy, employee);
};

const saveQuickExecutePreferences = async ({ executorId, network, pin, clearPin = false }) => {
    const employee = await loadExecutorForQuickExecute(executorId, { includePin: true });
    const nextNetwork = network === undefined || network === null || network === ''
        ? normalizeUssdNetwork(employee.ussdNetwork)
        : normalizeUssdNetwork(network);
    if (network !== undefined && network !== null && network !== '' && !USSD_NETWORKS[String(network).trim().toLowerCase()]) {
        throw new QuickExecuteError('INVALID_NETWORK', 'اختر شبكة صحيحة: فودافون أو اتصالات أو أورنج أو وي.');
    }

    employee.ussdNetwork = nextNetwork;

    if (clearPin === true) {
        employee.ussdWalletPinEncrypted = undefined;
        employee.ussdWalletPinSetAt = undefined;
    } else if (pin !== undefined && pin !== null && String(pin).trim() !== '') {
        const validated = validateWalletPin(pin, { required: true });
        if (!validated.ok) {
            throw new QuickExecuteError(validated.code, validated.message);
        }
        employee.ussdWalletPinEncrypted = encrypt(validated.pin);
        employee.ussdWalletPinSetAt = new Date();
    }

    await employee.save();
    invalidateExecutorAuth(employee._id);
    const policy = readExecutorManualPolicy(employee.groupId, employee);
    return toPublicQuickExecuteState(policy, employee);
};

const resolveStoredPin = (employee) => {
    const encrypted = employee?.ussdWalletPinEncrypted;
    if (!encrypted) return '';
    try {
        return decrypt(encrypted) || '';
    } catch (_error) {
        return '';
    }
};

const loadDialCandidate = async (taskId) => {
    if (typeof Transaction.findById !== 'function') return null;
    return Transaction.findById(taskId);
};

const throwAcceptFailure = (result) => {
    const code = result?.code || 'TASK_UNAVAILABLE';
    if (code === 'TASK_ASSIGNED_TO_OTHER' || code === 'TASK_TAKEN' || code === 'FORBIDDEN') {
        throw new QuickExecuteError(code, TASK_NOT_CLAIMABLE_AR, 403);
    }
    if (code === 'ACTIVE_TASK_EXISTS' || code === 'ROUTING_REQUIRED') {
        throw new QuickExecuteError(code, routingErrorMessage(code), 409);
    }
    throw new QuickExecuteError('TASK_NOT_ACCEPTED', TASK_NOT_ACCEPTED_AR, 403);
};

const resolveDialTask = async ({ employee, taskId, tenantId, autoAccept }) => {
    const tenantScope = normalizeDialTenantScope(tenantId);
    const ownedTask = await findOwnedAcceptedExecutorTask({
        transactionId: taskId,
        executor: employee,
        tenantId: tenantScope
    });
    if (ownedTask) return { task: ownedTask, acceptedNow: false };

    const candidate = await loadDialCandidate(taskId);
    if (!candidate) {
        throw new QuickExecuteError('TASK_NOT_FOUND', 'لم تعد العملية موجودة في النظام. حدّث قائمة المهام.', 404);
    }
    if (!isCashWalletTask(candidate)) {
        throw new QuickExecuteError('NOT_CASH_WALLET', 'التنفيذ السريع متاح لتحويلات المحفظة النقدية فقط.');
    }

    if (executorOwnsAcceptedTask(candidate, employee)) {
        return { task: candidate, acceptedNow: false };
    }

    const claimable = ACCEPTABLE_DIAL_STATUSES.has(String(candidate.status || ''));
    if (autoAccept && claimable && taskAssignedToExecutor(candidate, employee)) {
        const accepted = await acceptExecutorTask({
            transactionId: taskId,
            executor: employee,
            tenantId: tenantScope
        });
        if (accepted?.ok || accepted?.replayed) {
            const task = accepted.transaction || await findOwnedAcceptedExecutorTask({
                transactionId: taskId,
                executor: employee,
                tenantId: tenantScope
            }) || candidate;
            const plain = task && typeof task.toObject === 'function' ? task.toObject() : task;
            return { task: { ...plain, status: 'accepted' }, acceptedNow: !accepted.replayed };
        }
        throwAcceptFailure(accepted);
    }

    if (claimable) {
        throw new QuickExecuteError('TASK_NOT_ACCEPTED', TASK_NOT_ACCEPTED_AR, 403);
    }
    throw new QuickExecuteError('TASK_NOT_OWNED', TASK_NOT_CLAIMABLE_AR, 403);
};

const buildQuickExecuteDial = async ({
    executorId,
    executor = null,
    taskId,
    pin,
    tenantId = null,
    autoAccept = true
} = {}) => {
    const employee = await loadExecutorForQuickExecute(executorId, { includePin: true });
    if (!employee.groupId && executor?.groupId) employee.groupId = executor.groupId;
    if (!employee.webUsername && executor?.webUsername) employee.webUsername = executor.webUsername;

    const policy = readExecutorManualPolicy(employee.groupId, employee);
    if (!policy.quickExecuteEnabled) {
        throw new QuickExecuteError('QUICK_EXECUTE_DISABLED', 'التنفيذ السريع غير مفعّل لحسابك.', 403);
    }

    const { task, acceptedNow } = await resolveDialTask({
        employee,
        taskId,
        tenantId,
        autoAccept
    });
    if (!isCashWalletTask(task)) {
        throw new QuickExecuteError('NOT_CASH_WALLET', 'التنفيذ السريع متاح لتحويلات المحفظة النقدية فقط.');
    }

    const phone = sanitizePhoneDigits(taskRecipientValue(task));
    const amount = sanitizeAmountDigits(task.amount);
    const network = normalizeUssdNetwork(employee.ussdNetwork);
    const pinRequired = networkRequiresPin(network);
    const providedPin = pin !== undefined && pin !== null && String(pin).trim() !== ''
        ? pin
        : resolveStoredPin(employee);

    if (pinRequired && !providedPin) {
        throw new QuickExecuteError(
            'PIN_REQUIRED',
            'رقم سر المحفظة مطلوب لشبكات اتصالات وأورنج ووي. احفظه مشفراً من الإعدادات أو أدخله لهذه المكالمة.'
        );
    }

    let ussd;
    try {
        ussd = buildUssdString({
            network,
            phone,
            amount,
            pin: providedPin
        });
    } catch (error) {
        throw new QuickExecuteError(error.code || 'INVALID_USSD', error.message || 'تعذر تجهيز كود الاتصال.');
    }

    return {
        network,
        networkLabel: USSD_NETWORKS[network]?.labelAr || network,
        pinIncluded: pinRequired,
        pinSet: Boolean(employee.ussdWalletPinSetAt),
        securityNote: pinRequired ? PIN_SECURITY_NOTE_AR : '',
        ussd,
        telUri: toTelUri(ussd),
        acceptedNow: Boolean(acceptedNow),
        debug: redactUssdForLog(ussd, providedPin),
        pinFingerprint: pinRequired && providedPin ? hashForLog(providedPin) : null
    };
};

module.exports = {
    QuickExecuteError,
    TASK_NOT_ACCEPTED_AR,
    TASK_NOT_CLAIMABLE_AR,
    buildQuickExecuteDial,
    getQuickExecuteState,
    normalizeDialTenantScope,
    saveQuickExecutePreferences,
    toPublicQuickExecuteState
};
