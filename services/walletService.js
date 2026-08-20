// services/walletService.js
// المحرك المالي الموحد ذو القيد المزدوج (Double Entry Accounting)
'use strict';

const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');

const requiresMongoTransactions = () => (
    process.env.NODE_ENV === 'production'
    || String(process.env.MONGO_TRANSACTIONS_REQUIRED || '').toLowerCase() === 'true'
);

const financialTransactionsUnavailableError = (cause) => {
    const error = new Error('FINANCIAL_TRANSACTIONS_UNAVAILABLE');
    error.code = 'FINANCIAL_TRANSACTIONS_UNAVAILABLE';
    error.statusCode = 503;
    error.cause = cause;
    return error;
};

const isMongoTransactionFallbackError = (error) => {
    const message = error && error.message ? error.message : '';
    return message.includes('replica set')
        || message.includes('Transaction numbers')
        || message.includes('transactions are not supported')
        || message.includes('retryable writes')
        || message.includes('mongos');
};

/**
 * تحديث رصيد حساب مع تسجيل قيد في دفتر الأستاذ بشكل ذري
 *
 * @param {string} entityModel  - اسم النموذج (User / ClientBot / SubAccount / ExecutorBot)
 * @param {string} entityId     - معرّف الحساب
 * @param {number} amount       - المبلغ (موجب = إيداع، سالب = خصم)
 * @param {string} type         - نوع العملية (DEPOSIT / DEDUCTION / TRANSFER / COMMISSION / REFUND / REVERSAL)
 * @param {string} transactionId - رقم الفاتورة المرتبطة
 * @param {string} description  - بيان العملية
 * @param {Object} [options]
 * @param {number} [options.minBalance=0]  - الحد الأدنى المطلوب للرصيد قبل الخصم
 * @param {boolean} [options.allowNegative=false] - يسمح بتجاوز الصفر للتسويات الإدارية فقط
 * @param {Object} [options.session]       - جلسة MongoDB موجودة (للعمليات المركبة)
 * @returns {Promise<{success: boolean, balanceAfter: number}>}
 */
const updateBalanceWithLedger = async (entityModel, entityId, amount, type, transactionId, description, options = {}) => {
    const {
        minBalance = 0,
        allowNegative = false,
        session: externalSession,
        tenantId: requestedTenantId
    } = options;
    const Model = mongoose.model(entityModel);

    // ── المسار الرئيسي: استخدام Transaction ذري ──────────────────────
    const runWithSession = async (session) => {
        // ✅ قفل ذري: يشترط وجود رصيد كافٍ قبل التعديل في عملية واحدة
        const filter = amount < 0 && !allowNegative
            ? { _id: entityId, balance: { $gte: minBalance + Math.abs(amount) } }
            : { _id: entityId };

        const account = await Model.findOneAndUpdate(
            filter,
            { $inc: { balance: amount } },
            { new: true, session }
        );

        if (!account) {
            throw new Error(amount < 0 && !allowNegative ? 'INSUFFICIENT_BALANCE' : 'ACCOUNT_NOT_FOUND');
        }

        const balanceBefore = account.balance - amount;
        const balanceAfter = account.balance;

        const ledger = new Ledger({
            tenantId: requestedTenantId || account.tenantId || undefined,
            entityId,
            entityModel,
            transactionId: transactionId || 'SYS-SYNC',
            type,
            amount,
            balanceBefore,
            balanceAfter,
            description
        });
        await ledger.save({ session });

        return { success: true, balanceBefore, balanceAfter };
    };

    // إذا تم تمرير جلسة خارجية استخدمها مباشرة
    if (externalSession) {
        return runWithSession(externalSession);
    }

    // ── المسار التلقائي: فتح جلسة جديدة ──────────────────────────────
    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();
        const result = await runWithSession(session);
        await session.commitTransaction();
        session.endSession();
        return result;

    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); session.endSession(); } catch (_) {}
        }

        // 🛡️ وضع بديل للسيرفر المحلي الذي لا يدعم Transactions (Replica Set مطلوب)
        if (isMongoTransactionFallbackError(error)) {
            if (requiresMongoTransactions()) {
                throw financialTransactionsUnavailableError(error);
            }
            console.warn(`⚠️ [WalletService] السيرفر لا يدعم Transactions. تفعيل الوضع البديل للعملية: ${transactionId}`);
            return executeFallback(
                Model,
                entityId,
                amount,
                type,
                transactionId,
                description,
                minBalance,
                allowNegative,
                requestedTenantId
            );
        }

        throw error;
    }
};

/**
 * الوضع البديل — يُستخدم فقط عند تعذّر Transactions
 * يستخدم findOneAndUpdate الذري لضمان عدم تكرار العملية
 */
const executeFallback = async (
    Model,
    entityId,
    amount,
    type,
    transactionId,
    description,
    minBalance,
    allowNegative = false,
    requestedTenantId = null
) => {
    // ✅ قفل ذري: نفس الحماية من خلال شرط الرصيد في الـ filter
    const filter = amount < 0 && !allowNegative
        ? { _id: entityId, balance: { $gte: minBalance + Math.abs(amount) } }
        : { _id: entityId };

    const account = await Model.findOneAndUpdate(
        filter,
        { $inc: { balance: amount } },
        { new: true }
    );

    if (!account) {
        throw new Error(amount < 0 && !allowNegative ? 'INSUFFICIENT_BALANCE' : 'ACCOUNT_NOT_FOUND');
    }

    const balanceBefore = account.balance - amount;
    const balanceAfter = account.balance;

    try {
        await Ledger.create({
            tenantId: requestedTenantId || account.tenantId || undefined,
            entityId,
            entityModel: Model.modelName,
            transactionId: transactionId || 'SYS-SYNC',
            type,
            amount,
            balanceBefore,
            balanceAfter,
            description
        });
    } catch (error) {
        await Model.updateOne({ _id: entityId }, { $inc: { balance: -amount } });
        throw error;
    }

    return { success: true, balanceBefore, balanceAfter };
};

module.exports = {
    updateBalanceWithLedger,
    isMongoTransactionFallbackError,
    requiresMongoTransactions,
    financialTransactionsUnavailableError
};
