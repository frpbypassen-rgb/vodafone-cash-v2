'use strict';

const mongoose = require('mongoose');
const Counter = require('../models/Counter');
const Ledger = require('../models/Ledger');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const Notification = require('../models/Notification');
const { resolveAccountByCode } = require('./accountCodeService');

const modelByName = {
    User,
    ClientCompany,
    SubAccount
};

const canUseMongoTransactions = async () => {
    try {
        if (!mongoose.connection.db) return false;
        const info = await mongoose.connection.db.admin().command({ replSetGetStatus: 1 }).catch(() => null);
        return Boolean(info);
    } catch (_) {
        return false;
    }
};

const nextBalanceTransferId = async (session) => {
    const counter = await Counter.findOneAndUpdate(
        { name: 'balance_transfer' },
        { $inc: { value: 1 } },
        { upsert: true, new: true, ...(session ? { session } : {}) }
    );
    const yy = new Date().getFullYear().toString().slice(-2);
    const mm = String(new Date().getMonth() + 1).padStart(2, '0');
    return `BTR-${yy}${mm}-${String(counter.value).padStart(4, '0')}`;
};

const accountName = (account) => account.doc.name || account.doc.webUsername || account.doc.phone || account.modelName;

const isActiveAccount = (account) => {
    if (!account?.doc) return false;
    return account.doc.status === 'active';
};

const assertDifferentAccounts = (source, target) => {
    if (source.modelName === target.modelName && String(source.doc._id) === String(target.doc._id)) {
        throw new Error('SAME_ACCOUNT');
    }
};

const buildEntityTransactionFields = async (account, customId, status, amount, notes, session) => {
    const base = {
        customId,
        transferType: 'balance_transfer',
        vodafoneNumber: account.doc.accountCode || 'BALANCE',
        accountNumber: account.doc.accountCode || '',
        accountName: accountName(account),
        amount,
        costLYD: 0,
        status,
        notes
    };

    if (account.modelName === 'User') {
        return {
            ...base,
            userId: account.doc.phone || account.doc.webUsername,
            companyId: null,
            subAccountId: null,
            companyName: account.doc.role === 'agent' ? 'وكيل فردي' : 'عميل فردي',
            employeeName: account.doc.name
        };
    }

    if (account.modelName === 'ClientCompany') {
        return {
            ...base,
            userId: 'balance-transfer',
            companyId: account.doc._id,
            subAccountId: null,
            companyName: account.doc.name,
            employeeName: account.performedBy || account.doc.name
        };
    }

    const masterModel = account.doc.masterType === 'company' ? ClientCompany : User;
    const master = await masterModel.findById(account.doc.masterId).session(session || null);

    return {
        ...base,
        userId: account.doc.masterType === 'user' && master ? (master.phone || master.webUsername) : null,
        companyId: account.doc.masterType === 'company' && master ? master._id : null,
        subAccountId: account.doc._id,
        isSubAccountTx: true,
        companyName: master ? master.name : 'وكيل غير معروف',
        subAccountName: account.doc.name,
        employeeName: account.doc.name
    };
};

const createLedgerEntries = (source, target, transferId, amount, sourceAfter, targetAfter) => ([
    {
        entityId: source.doc._id,
        entityModel: source.modelName,
        transactionId: transferId,
        type: 'TRANSFER',
        amount: -amount,
        balanceBefore: sourceAfter.balance + amount,
        balanceAfter: sourceAfter.balance,
        description: `تحويل رصيد إلى ${accountName(target)} (${target.doc.accountCode})`
    },
    {
        entityId: target.doc._id,
        entityModel: target.modelName,
        transactionId: transferId,
        type: 'TRANSFER',
        amount,
        balanceBefore: targetAfter.balance - amount,
        balanceAfter: targetAfter.balance,
        description: `استلام رصيد من ${accountName(source)} (${source.doc.accountCode || 'بدون ID'})`
    }
]);

const notifyAccount = async (account, title, message, type = 'transfer') => {
    try {
        if (account.modelName === 'User') {
            const userId = account.doc.phone || account.doc.webUsername;
            if (userId) await Notification.create({ userId, title, message, type });
            return;
        }

        if (account.modelName === 'SubAccount') {
            await Notification.create({ userId: account.doc.webUsername, title, message, type });
            return;
        }

        const employees = await ClientEmployee.find({ companyId: account.doc._id, status: 'active' }).select('webUsername').lean();
        await Promise.all(employees.map((emp) => Notification.create({ userId: emp.webUsername, title, message, type }).catch(() => {})));
    } catch (_) {}
};

const executeBalanceTransfer = async ({ source, targetCode, amount, notes = '' }) => {
    const normalizedAmount = Number(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new Error('INVALID_AMOUNT');
    }

    const target = await resolveAccountByCode(targetCode);
    if (!target) throw new Error('TARGET_NOT_FOUND');
    if (!isActiveAccount(source)) throw new Error('SOURCE_INACTIVE');
    if (!isActiveAccount(target)) throw new Error('TARGET_INACTIVE');
    assertDifferentAccounts(source, target);

    const transferId = await nextBalanceTransferId();
    const SourceModel = modelByName[source.modelName];
    const TargetModel = modelByName[target.modelName];
    const description = notes ? notes.trim() : '';
    const sourceNotes = `تحويل رصيد صادر إلى ${accountName(target)} - ID: ${target.doc.accountCode}${description ? ` | ${description}` : ''}`;
    const targetNotes = `تحويل رصيد وارد من ${accountName(source)} - ID: ${source.doc.accountCode || 'غير محدد'}${description ? ` | ${description}` : ''}`;

    const useTransaction = await canUseMongoTransactions();
    let session = null;
    let sourceAfter;
    let targetAfter;

    try {
        if (useTransaction) {
            session = await mongoose.startSession();
            session.startTransaction();
        }

        const options = session ? { session } : {};
        sourceAfter = await SourceModel.findOneAndUpdate(
            { _id: source.doc._id, balance: { $gte: normalizedAmount } },
            { $inc: { balance: -normalizedAmount } },
            { new: true, ...options }
        );
        if (!sourceAfter) throw new Error('INSUFFICIENT_BALANCE');

        targetAfter = await TargetModel.findByIdAndUpdate(
            target.doc._id,
            { $inc: { balance: normalizedAmount } },
            { new: true, ...options }
        );
        if (!targetAfter) throw new Error('TARGET_NOT_FOUND');

        const sourceTx = await buildEntityTransactionFields(source, `${transferId}-D`, 'deduction', normalizedAmount, sourceNotes, session);
        const targetTx = await buildEntityTransactionFields(target, `${transferId}-C`, 'deposit', normalizedAmount, targetNotes, session);
        await Transaction.create([sourceTx, targetTx], options);

        const ledgerEntries = createLedgerEntries(source, target, transferId, normalizedAmount, sourceAfter, targetAfter);
        await Ledger.create(ledgerEntries, options);

        if (session) {
            await session.commitTransaction();
            session.endSession();
        }

        notifyAccount(source, 'تحويل رصيد صادر', `تم تحويل ${normalizedAmount.toFixed(2)} LYD إلى ${accountName(target)}. رقم العملية: ${transferId}`, 'deduction').catch(() => {});
        notifyAccount(target, 'تحويل رصيد وارد', `تم استلام ${normalizedAmount.toFixed(2)} LYD من ${accountName(source)}. رقم العملية: ${transferId}`, 'deposit').catch(() => {});

        return {
            success: true,
            transferId,
            amount: normalizedAmount,
            sourceBalance: sourceAfter.balance,
            targetName: accountName(target),
            targetCode: target.doc.accountCode,
            targetType: target.label
        };
    } catch (error) {
        if (session) {
            try {
                await session.abortTransaction();
                session.endSession();
            } catch (_) {}
        } else if (sourceAfter) {
            await SourceModel.findByIdAndUpdate(source.doc._id, { $inc: { balance: normalizedAmount } }).catch(() => {});
            if (targetAfter) {
                await TargetModel.findByIdAndUpdate(target.doc._id, { $inc: { balance: -normalizedAmount } }).catch(() => {});
            }
            await Transaction.deleteMany({ customId: { $in: [`${transferId}-D`, `${transferId}-C`] } }).catch(() => {});
            await Ledger.deleteMany({ transactionId: transferId }).catch(() => {});
        }
        throw error;
    }
};

module.exports = { executeBalanceTransfer };
