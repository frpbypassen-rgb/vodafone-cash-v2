// services/walletService.js
const mongoose = require('mongoose');
const Ledger = require('../models/Ledger'); 

/**
 * المحرك المالي الموحد ذو القيد المزدوج (Double Entry Accounting)
 */
const updateBalanceWithLedger = async (entityModel, entityId, amount, type, transactionId, description) => {
    const Model = mongoose.model(entityModel);

    // 🟢 الدالة البديلة (تعمل على أي سيرفر محلي لا يدعم الـ Transactions)
    const executeFallback = async () => {
        const account = await Model.findById(entityId);
        if (!account) throw new Error('الحساب غير موجود');
        
        const balanceBefore = account.balance || 0;
        const balanceAfter = balanceBefore + amount;
        account.balance = balanceAfter;
        await account.save();

        await Ledger.create({
            entityId, 
            entityModel, 
            transactionId: transactionId || 'SYS-SYNC',
            type, 
            amount, 
            balanceBefore, 
            balanceAfter, 
            description
        });

        return { success: true, balanceAfter };
    };

    let session;
    try {
        // محاولة استخدام Transactions (ستعمل تلقائياً على السيرفرات السحابية)
        session = await mongoose.startSession();
        session.startTransaction();
        
        const account = await Model.findById(entityId).session(session);
        if (!account) throw new Error('الحساب غير موجود');

        const balanceBefore = account.balance || 0;
        const balanceAfter = balanceBefore + amount;
        account.balance = balanceAfter;
        await account.save({ session });

        const ledger = new Ledger({
            entityId, entityModel, transactionId: transactionId || 'SYS-SYNC',
            type, amount, balanceBefore, balanceAfter, description
        });
        await ledger.save({ session });

        await session.commitTransaction();
        session.endSession();
        return { success: true, balanceAfter };

    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); session.endSession(); } catch(e){}
        }
        
        // 🟢 التقاط خطأ السيرفر المحلي وتشغيل الوضع البديل بأمان لاستكمال العملية
        if (error.message.includes('replica set') || error.message.includes('Transaction') || error.message.includes('mongos')) {
            console.warn(`⚠️ [نظام الحماية]: السيرفر المحلي لا يدعم Transactions. تم تفعيل الوضع البديل لحفظ العملية: ${transactionId}`);
            return await executeFallback();
        }
        
        throw error;
    }
};

module.exports = { updateBalanceWithLedger };