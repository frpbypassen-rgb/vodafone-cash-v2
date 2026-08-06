'use strict';

const crypto = require('crypto');

const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const { escapeRegex } = require('../utils/helpers');

class ExecutorAccountError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ExecutorAccountError';
        this.code = code;
    }
}

const normalizeText = (value) => String(value || '').trim();

const normalizeExecutorUsername = (value) => {
    const raw = normalizeText(value).toLowerCase();
    const prefix = raw.replace(/@ahram\.com$/i, '');
    if (!/^[a-z0-9_]{3,40}$/.test(prefix)) {
        throw new ExecutorAccountError(
            'INVALID_USERNAME',
            'اسم الدخول يجب أن يتكون من 3 إلى 40 حرفاً إنجليزياً أو رقماً أو شرطة سفلية.'
        );
    }
    return `${prefix}@ahram.com`;
};

const normalizeExecutorPhone = (value) => {
    const phone = normalizeText(value).replace(/[\s()-]/g, '');
    const digits = phone.replace(/^\+/, '');
    if (!/^\d{8,15}$/.test(digits)) {
        throw new ExecutorAccountError('INVALID_PHONE', 'رقم الهاتف غير صالح.');
    }
    return phone;
};

const assertManagerData = (managerData) => {
    const name = normalizeText(managerData?.name);
    const password = normalizeText(managerData?.webPassword);
    if (name.length < 3) {
        throw new ExecutorAccountError('INVALID_MANAGER_NAME', 'يرجى إدخال اسم مسؤول المنفذ كاملاً.');
    }
    if (password.length < 6) {
        throw new ExecutorAccountError('WEAK_PASSWORD', 'كلمة المرور يجب ألا تقل عن 6 أحرف.');
    }

    return {
        ...managerData,
        name,
        phone: normalizeExecutorPhone(managerData.phone),
        webUsername: normalizeExecutorUsername(managerData.webUsername),
        webPassword: password
    };
};

const assertUsernameAvailable = async (webUsername) => {
    const usernameRegex = new RegExp(`^${escapeRegex(webUsername)}$`, 'i');
    const exists = await Employee.exists({ webUsername: usernameRegex });
    if (exists) {
        throw new ExecutorAccountError('USERNAME_TAKEN', 'اسم الدخول مستخدم بالفعل.');
    }
};

const openingTransactionId = () => (
    `EXEC-OPEN-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
);

const createExecutorAccount = async ({ groupData, managerData, openingBalance = 0, tenantId }) => {
    const name = normalizeText(groupData?.name);
    if (!name) {
        throw new ExecutorAccountError('MISSING_NAME', 'اسم المنفذ مطلوب.');
    }

    const isApiBot = Boolean(groupData?.isApiBot || groupData?.isApiGroup);
    const preparedManager = managerData ? assertManagerData(managerData) : null;
    if (!isApiBot && !preparedManager) {
        throw new ExecutorAccountError('MISSING_LOGIN', 'بيانات دخول مسؤول المنفذ مطلوبة.');
    }
    if (preparedManager) await assertUsernameAvailable(preparedManager.webUsername);

    const parsedBalance = openingBalance === '' || openingBalance === null || openingBalance === undefined
        ? 0
        : Number(openingBalance);
    if (!Number.isFinite(parsedBalance)) {
        throw new ExecutorAccountError('INVALID_BALANCE', 'الرصيد الافتتاحي غير صالح.');
    }

    let group = null;
    let employee = null;
    let openingTransaction = null;

    try {
        group = await ExecutorGroup.create({ ...groupData, name });

        if (preparedManager) {
            employee = await Employee.create({
                ...preparedManager,
                role: 'manager',
                status: 'active',
                groupId: group._id,
                canViewAllReports: true,
                tenantId: tenantId || undefined
            });
        }

        if (parsedBalance !== 0) {
            openingTransaction = await Transaction.create({
                customId: openingTransactionId(),
                userId: 'admin',
                executorGroupId: group._id,
                amount: Math.abs(parsedBalance),
                costLYD: 0,
                vodafoneNumber: 'رصيد افتتاحي',
                status: parsedBalance > 0 ? 'deposit' : 'deduction',
                companyName: 'الإدارة المركزية',
                employeeName: 'إنشاء حساب المنفذ',
                executorName: group.name,
                notes: '',
                adminNotes: `الرصيد الافتتاحي عند إنشاء المنفذ: ${parsedBalance}`,
                tenantId: tenantId || undefined
            });
        }

        group.balance = parsedBalance;
        await group.save();

        return { group, employee, openingTransaction };
    } catch (error) {
        if (openingTransaction?._id) await Transaction.deleteOne({ _id: openingTransaction._id }).catch(() => {});
        if (employee?._id) await Employee.deleteOne({ _id: employee._id }).catch(() => {});
        if (group?._id) await ExecutorGroup.deleteOne({ _id: group._id }).catch(() => {});
        throw error;
    }
};

const createRegisteredExecutorAccount = ({ companyName, managerName, phone, webUsername, webPassword, tenantId }) => (
    createExecutorAccount({
        groupData: {
            name: companyName,
            status: 'active',
            isManagerGroup: false,
            isManagerBot: false,
            isApiGroup: false,
            isApiBot: false
        },
        managerData: {
            name: managerName,
            phone,
            webUsername,
            webPassword
        },
        openingBalance: 0,
        tenantId
    })
);

module.exports = {
    ExecutorAccountError,
    createExecutorAccount,
    createRegisteredExecutorAccount,
    normalizeExecutorPhone,
    normalizeExecutorUsername
};
