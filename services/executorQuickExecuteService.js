'use strict';

const Employee = require('../models/Employee');
const { decrypt, encrypt, hashForLog } = require('../utils/encryption');
const { findOwnedAcceptedExecutorTask } = require('./executorTaskRoutingService');
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
const { taskRecipientValue } = require('../utils/executorTaskPrivacy');

class QuickExecuteError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'QuickExecuteError';
        this.code = code;
        this.status = status;
    }
}

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

const buildQuickExecuteDial = async ({ executorId, taskId, pin, tenantId = null }) => {
    const employee = await loadExecutorForQuickExecute(executorId, { includePin: true });
    const policy = readExecutorManualPolicy(employee.groupId, employee);
    if (!policy.quickExecuteEnabled) {
        throw new QuickExecuteError('QUICK_EXECUTE_DISABLED', 'التنفيذ السريع غير مفعّل لحسابك.', 403);
    }

    const task = await findOwnedAcceptedExecutorTask({
        transactionId: taskId,
        executor: employee,
        tenantId
    });
    if (!task) {
        throw new QuickExecuteError('TASK_NOT_OWNED', 'هذه المهمة ليست ضمن مهامك المقبولة.', 403);
    }
    if (String(task.transferType || '').trim() !== 'vodafone') {
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
        debug: redactUssdForLog(ussd, providedPin),
        pinFingerprint: pinRequired && providedPin ? hashForLog(providedPin) : null
    };
};

module.exports = {
    QuickExecuteError,
    buildQuickExecuteDial,
    getQuickExecuteState,
    saveQuickExecutePreferences,
    toPublicQuickExecuteState
};
