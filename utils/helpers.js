// utils/helpers.js
// ====================================================
// 🔧 الدوال المساعدة المركزية — لمنع تكرار الكود
// ====================================================
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const bcrypt = require('bcryptjs');
const { getExecutorPrimaryServiceKey } = require('./executorServiceCatalog');
const { ledgerServiceKeyForTransaction } = require('./executorServiceLedger');

// ────────────────────────────────────────────────────────────
// 1️⃣ مزامنة رصيد البوت المنفذ من العمليات المالية
// ────────────────────────────────────────────────────────────
const syncBotBalance = async (botId) => {
    const bot = await ExecutorGroup.findById(botId);
    if (!bot) return 0;
    
    let queryFilter = {};
    // Funding an external executor (or their shared pool) is an internal
    // allocation. Those rows must not inflate or deflate the company ledger
    // that admin and syncBotBalance treat as the company total/private split.
    const excludeInternalAllocation = { transferType: { $ne: 'external_balance' } };
    if (bot.isManagerGroup) {
        queryFilter = {
            $and: [
                excludeInternalAllocation,
                {
                    $or: [
                        { managerGroupId: bot._id, status: 'completed' },
                        { executorGroupId: bot._id, status: { $in: ['deposit', 'deduction'] } }
                    ]
                }
            ]
        };
    } else {
        queryFilter = {
            executorGroupId: bot._id,
            status: { $in: ['completed', 'deposit', 'deduction'] },
            ...excludeInternalAllocation
        };
    }

    const primary = getExecutorPrimaryServiceKey(bot);
    const txs = await Transaction.find(queryFilter);
    const byService = {};
    txs.forEach((t) => {
        const serviceKey = ledgerServiceKeyForTransaction(t, primary);
        if (!serviceKey) return;
        const current = Number(byService[serviceKey] || 0);
        if (t.status === 'completed') byService[serviceKey] = current - Number(t.amount || 0);
        else if (t.status === 'deposit') byService[serviceKey] = current + Number(t.amount || 0);
        else if (t.status === 'deduction') byService[serviceKey] = current - Math.abs(Number(t.amount || 0));
    });

    bot.serviceBalances = byService;
    bot.balance = Number(byService[primary] || 0);
    await bot.save();
    return bot.balance;
};

// ────────────────────────────────────────────────────────────
// 2️⃣ التحقق من كلمة المرور + ترقية تلقائية إلى bcrypt
// يُستخدم في: mobileApi, clientPortal, executorPortal, auth
// ────────────────────────────────────────────────────────────
const verifyAndUpgradePassword = async (plainPassword, storedPassword, Model, docId) => {
    if (!storedPassword) return false;

    let isMatch = false;
    if (storedPassword.startsWith('$2')) {
        // كلمة المرور مشفرة — تحقق مباشر
        isMatch = await bcrypt.compare(plainPassword, storedPassword);
    } else {
        // كلمة المرور نص عادي — تحقق ثم ترقية
        isMatch = (plainPassword === storedPassword);
        if (isMatch) {
            const hashed = await bcrypt.hash(plainPassword, 12);
            await Model.updateOne({ _id: docId }, { webPassword: hashed });
        }
    }
    return isMatch;
};

// ────────────────────────────────────────────────────────────
// 3️⃣ تنسيق التاريخ الحالي بتوقيت طرابلس
// يُستخدم في: clientPortal, executorPortal
// ────────────────────────────────────────────────────────────
const getTodayString = () => {
    return new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });
};

// ────────────────────────────────────────────────────────────
// 4️⃣ هروب الأحرف الخاصة في Regex
// يمنع هجمات NoSQL Injection عبر الـ RegExp
// ────────────────────────────────────────────────────────────
const escapeRegex = (str) => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

module.exports = { 
    syncBotBalance, 
    verifyAndUpgradePassword, 
    getTodayString, 
    escapeRegex 
};