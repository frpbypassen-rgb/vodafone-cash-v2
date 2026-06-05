// services/walletService.js
// المحرك المالي الموحد ذو القيد المزدوج (Double Entry Accounting)
'use strict';

const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');

/**
 * تحديث رصيد حساب مع تسجيل قيد في دفتر الأستاذ بشكل ذري
 *
 * @param {string} entityModel  - اسم النموذج (User / ClientBot / SubAccount / ExecutorBot)
 * @param {string} entityId     - معرّف الحساب
 * @param {number} amount       - المبلغ (موجب = إيداع، سالب = خصم)
 * @param {string} type         - نوع العملية (DEPOSIT / DEDUCTION / TRANSFER / COMMISSION / REFUND)
 * @param {string} transactionId - رقم الفاتورة المرتبطة
 * @param {string} description  - بيان العملية
 * @param {Object} [options]
 * @param {number} [options.minBalance=0]  - الحد الأدنى المطلوب للرصيد قبل الخصم
 * @param {Object} [options.session]       - جلسة MongoDB موجودة (للعمليات المركبة)
 * @returns {Promise<{success: boolean, balanceAfter: number}>}
 */
const updateBalanceWithLedger = async (entityModel, entityId, amount, type, transactionId, description, options = {}) => {
    const { minBalance = 0, session: externalSession } = options;
    const Model = mongoose.model(entityModel);

    // ── المسار الرئيسي: استخدام Transaction ذري ──────────────────────
    const runWithSession = async (session) => {
        // ✅ قفل ذري: يشترط وجود رصيد كافٍ قبل التعديل في عملية واحدة
        const filter = amount < 0
            ? { _id: entityId, balance: { $gte: minBalance + Math.abs(amount) } }
            : { _id: entityId };

        const account = await Model.findOneAndUpdate(
            filter,
            { $inc: { balance: amount } },
            { new: true, session }
        );

        if (!account) {
            throw new Error(amount < 0 ? 'INSUFFICIENT_BALANCE' : 'ACCOUNT_NOT_FOUND');
        }

        const balanceBefore = account.balance - amount;
        const balanceAfter = account.balance;

        const ledger = new Ledger({
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
        if (
            error.message.includes('replica set') ||
            error.message.includes('Transaction numbers') ||
            error.message.includes('mongos')
        ) {
            console.warn(`⚠️ [WalletService] السيرفر لا يدعم Transactions. تفعيل الوضع البديل للعملية: ${transactionId}`);
            return executeFallback(Model, entityId, amount, type, transactionId, description, minBalance);
        }

        throw error;
    }
};

/**
 * الوضع البديل — يُستخدم فقط عند تعذّر Transactions
 * يستخدم findOneAndUpdate الذري لضمان عدم تكرار العملية
 */
const executeFallback = async (Model, entityId, amount, type, transactionId, description, minBalance) => {
    // ✅ قفل ذري: نفس الحماية من خلال شرط الرصيد في الـ filter
    const filter = amount < 0
        ? { _id: entityId, balance: { $gte: minBalance + Math.abs(amount) } }
        : { _id: entityId };

    const account = await Model.findOneAndUpdate(
        filter,
        { $inc: { balance: amount } },
        { new: true }
    );

    if (!account) {
        throw new Error(amount < 0 ? 'INSUFFICIENT_BALANCE' : 'ACCOUNT_NOT_FOUND');
    }

    const balanceBefore = account.balance - amount;
    const balanceAfter = account.balance;

    await Ledger.create({
        entityId,
        entityModel: Model.modelName,
        transactionId: transactionId || 'SYS-SYNC',
        type,
        amount,
        balanceBefore,
        balanceAfter,
        description
    });

    return { success: true, balanceBefore, balanceAfter };
};

module.exports = { updateBalanceWithLedger };