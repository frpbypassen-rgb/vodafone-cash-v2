'use strict';

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const ExecutorGroup = require('../models/ExecutorGroup');
const { calculateTransferCostLYD } = require('../utils/transferPricing');
const { executorSupportsTransferType } = require('../utils/executorServiceCatalog');
const {
    isMongoTransactionFallbackError,
    requiresMongoTransactions,
    financialTransactionsUnavailableError
} = require('./walletService');

const appendNote = (current, note) => [current, String(note || '').trim()]
    .filter(Boolean)
    .join('\n');

const withOptionalMongoTransaction = async (work) => {
    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();
        const result = await work(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        if (session) await session.abortTransaction().catch(() => {});
        if (isMongoTransactionFallbackError(error) && !requiresMongoTransactions()) {
            return work(null);
        }
        if (isMongoTransactionFallbackError(error) || (!session && requiresMongoTransactions())) {
            throw financialTransactionsUnavailableError(error);
        }
        throw error;
    } finally {
        if (session) session.endSession();
    }
};

const queryWithSession = (query, session) => (session ? query.session(session) : query);

const incrementBalance = async ({ Model, filter, amount, session, modelName }) => {
    if (!amount) return null;
    const options = { new: true, ...(session ? { session } : {}) };
    const record = await Model.findOneAndUpdate(filter, { $inc: { balance: amount } }, options);
    if (!record) throw new Error('FINANCIAL_OWNER_NOT_FOUND');
    return { model: modelName, id: record._id };
};

const adjustOwnerBalance = async ({ transaction, deltaLYD, session }) => {
    if (!deltaLYD) return null;

    if (transaction.companyId) {
        return incrementBalance({
            Model: ClientCompany,
            filter: { _id: transaction.companyId },
            amount: -deltaLYD,
            session,
            modelName: 'ClientCompany'
        });
    }

    if (transaction.userId) {
        return incrementBalance({
            Model: User,
            filter: { phone: transaction.userId },
            amount: -deltaLYD,
            session,
            modelName: 'User'
        });
    }

    return null;
};

/**
 * Reprices a customer transfer while keeping the transaction record and the
 * owner's balance in one database transaction.
 */
const repriceTransaction = async ({ transactionId, newRate, adminName, noteDetail = '' }) => withOptionalMongoTransaction(async (session) => {
    const transaction = await queryWithSession(Transaction.findById(transactionId), session);
    if (!transaction) throw new Error('TRANSACTION_NOT_FOUND');
    if (['rejected', 'cancelled_by_admin'].includes(transaction.status)) {
        throw new Error('TRANSACTION_NOT_EDITABLE');
    }

    const normalizedRate = Number(newRate);
    if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) {
        throw new Error('INVALID_EXCHANGE_RATE');
    }

    const oldCostLYD = Number(transaction.costLYD || 0);
    const oldRate = Number(transaction.exchangeRate || 0);
    const newCostLYD = calculateTransferCostLYD({
        serviceKey: transaction.transferType,
        amount: transaction.amount,
        exchangeRate: normalizedRate
    });
    const deltaLYD = newCostLYD - oldCostLYD;

    const owner = await adjustOwnerBalance({ transaction, deltaLYD, session });
    const detail = String(noteDetail || '').trim();
    const note = `[تم تعديل السعر من ${oldRate.toFixed(3)} إلى ${normalizedRate.toFixed(3)} بواسطة: ${adminName || 'الإدارة'}${detail ? ` | السبب: ${detail}` : ''}]`;
    const updated = await Transaction.findOneAndUpdate(
        { _id: transaction._id },
        {
            $set: {
                costLYD: newCostLYD,
                exchangeRate: normalizedRate,
                adminNotes: appendNote(transaction.adminNotes, note),
                updatedAt: new Date()
            }
        },
        { new: true, ...(session ? { session } : {}), timestamps: false }
    );
    if (!updated) throw new Error('TRANSACTION_UPDATE_CONFLICT');

    return { transaction: updated, oldCostLYD, oldRate, newCostLYD, owner };
});

/**
 * Updates a transaction amount, its calculated cost and every affected
 * balance atomically. Deposit and deduction records affect the customer's
 * balance directly; completed transfers also affect their executor balances.
 */
const editTransactionAmount = async ({
    transactionId,
    newAmount,
    adminName,
    noteDetail = '',
    createdAt
}) => withOptionalMongoTransaction(async (session) => {
    const transaction = await queryWithSession(Transaction.findById(transactionId), session);
    if (!transaction) throw new Error('TRANSACTION_NOT_FOUND');
    if (['rejected', 'cancelled_by_admin'].includes(transaction.status)) {
        throw new Error('TRANSACTION_NOT_EDITABLE');
    }

    const normalizedAmount = Number(newAmount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new Error('INVALID_AMOUNT');
    }

    const effectiveDate = createdAt ? new Date(createdAt) : null;
    if (effectiveDate && Number.isNaN(effectiveDate.getTime())) throw new Error('INVALID_TRANSACTION_DATE');

    const oldAmountEGP = Number(transaction.amount || 0);
    const oldCostLYD = Number(transaction.costLYD || 0);
    let newCostLYD = oldCostLYD;
    const noteDetailText = String(noteDetail || '').trim();
    const dateText = effectiveDate ? `، التاريخ: ${effectiveDate.toLocaleString('en-GB')}` : '';
    const note = `[تم تعديل المبلغ من ${oldAmountEGP} إلى ${normalizedAmount}${dateText} بواسطة: ${adminName || 'الإدارة'}${noteDetailText ? ` | السبب: ${noteDetailText}` : ''}]`;
    const transactionUpdate = {
        amount: normalizedAmount,
        adminNotes: appendNote(transaction.adminNotes, note),
        updatedAt: new Date()
    };
    if (effectiveDate) transactionUpdate.createdAt = effectiveDate;

    let owner = null;
    let syncGroupIds = [];
    if (transaction.status === 'deposit' || transaction.status === 'deduction') {
        const amountDifference = normalizedAmount - oldAmountEGP;
        const balanceDifference = transaction.status === 'deposit' ? amountDifference : -amountDifference;
        if (transaction.userId === 'admin' && transaction.executorGroupId) {
            syncGroupIds = [transaction.executorGroupId, transaction.managerGroupId].filter(Boolean);
        } else if (transaction.companyId) {
            owner = await incrementBalance({
                Model: ClientCompany,
                filter: { _id: transaction.companyId },
                amount: balanceDifference,
                session,
                modelName: 'ClientCompany'
            });
        } else if (transaction.userId) {
            owner = await incrementBalance({
                Model: User,
                filter: { phone: transaction.userId },
                amount: balanceDifference,
                session,
                modelName: 'User'
            });
        }
    } else {
        const exchangeRate = Number(transaction.exchangeRate);
        if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error('INVALID_EXCHANGE_RATE');
        newCostLYD = calculateTransferCostLYD({
            serviceKey: transaction.transferType,
            amount: normalizedAmount,
            exchangeRate
        });
        const amountDifference = normalizedAmount - oldAmountEGP;
        const costDifference = newCostLYD - oldCostLYD;
        owner = await adjustOwnerBalance({ transaction, deltaLYD: costDifference, session });
        transactionUpdate.costLYD = newCostLYD;

        if (transaction.status === 'completed' && transaction.executorGroupId) {
            await incrementBalance({
                Model: ExecutorGroup,
                filter: { _id: transaction.executorGroupId },
                amount: -amountDifference,
                session,
                modelName: 'ExecutorGroup'
            });
            if (transaction.managerGroupId) {
                await incrementBalance({
                    Model: ExecutorGroup,
                    filter: { _id: transaction.managerGroupId },
                    amount: -amountDifference,
                    session,
                    modelName: 'ExecutorGroup'
                });
            }
        }
    }

    const updated = await Transaction.findOneAndUpdate(
        { _id: transaction._id },
        { $set: transactionUpdate },
        { new: true, ...(session ? { session } : {}), timestamps: false }
    );
    if (!updated) throw new Error('TRANSACTION_UPDATE_CONFLICT');

    return {
        transaction: updated,
        oldAmountEGP,
        oldCostLYD,
        oldCreatedAt: transaction.createdAt,
        newAmount: normalizedAmount,
        newCostLYD,
        owner,
        syncGroupIds
    };
});

/** Reassigns a completed transfer and its executor ledger balances atomically. */
const reassignTransactionExecutor = async ({ transactionId, newGroupId }) => withOptionalMongoTransaction(async (session) => {
    const transaction = await queryWithSession(Transaction.findById(transactionId), session);
    if (!transaction) throw new Error('TRANSACTION_NOT_FOUND');
    if (transaction.status !== 'completed') throw new Error('TRANSACTION_NOT_COMPLETED');
    if (transaction.executorGroupId && String(transaction.executorGroupId) === String(newGroupId)) {
        throw new Error('EXECUTOR_ALREADY_ASSIGNED');
    }

    const newGroup = await queryWithSession(ExecutorGroup.findById(newGroupId), session);
    if (!newGroup || newGroup.status !== 'active' || newGroup.isManagerBot || !executorSupportsTransferType(newGroup, transaction.transferType)) {
        throw new Error('EXECUTOR_SERVICE_MISMATCH');
    }

    const amount = Number(transaction.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
    if (transaction.executorGroupId) {
        await incrementBalance({
            Model: ExecutorGroup,
            filter: { _id: transaction.executorGroupId },
            amount,
            session,
            modelName: 'ExecutorGroup'
        });
    }
    if (transaction.managerGroupId) {
        await incrementBalance({
            Model: ExecutorGroup,
            filter: { _id: transaction.managerGroupId },
            amount,
            session,
            modelName: 'ExecutorGroup'
        });
    }

    await incrementBalance({
        Model: ExecutorGroup,
        filter: { _id: newGroup._id },
        amount: -amount,
        session,
        modelName: 'ExecutorGroup'
    });
    const newManagerId = newGroup.parentGroupId || newGroup.parentBotId || null;
    if (newManagerId) {
        await incrementBalance({
            Model: ExecutorGroup,
            filter: { _id: newManagerId },
            amount: -amount,
            session,
            modelName: 'ExecutorGroup'
        });
    }

    const note = `[تم النقل محاسبياً إلى بوت: ${newGroup.name || 'غير معروف'}]`;
    const updated = await Transaction.findOneAndUpdate(
        { _id: transaction._id },
        {
            $set: {
                executorGroupId: newGroup._id,
                managerGroupId: newManagerId,
                executorName: newGroup.name || 'غير محدد',
                adminNotes: appendNote(transaction.adminNotes, note),
                updatedAt: new Date()
            }
        },
        { new: true, ...(session ? { session } : {}), timestamps: false }
    );
    if (!updated) throw new Error('TRANSACTION_UPDATE_CONFLICT');

    return {
        transaction: updated,
        oldExecutorGroupId: transaction.executorGroupId,
        oldExecutorName: transaction.executorName
    };
});

module.exports = {
    repriceTransaction,
    editTransactionAmount,
    reassignTransactionExecutor,
    withOptionalMongoTransaction
};
