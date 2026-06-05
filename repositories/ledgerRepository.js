// repositories/ledgerRepository.js
// ===============================================
// 📦 طبقة الوصول للبيانات — دفتر الأستاذ
// ===============================================
'use strict';

const Ledger = require('../models/Ledger');

/**
 * إنشاء قيد في دفتر الأستاذ
 * @param {Object} data
 * @param {Object} [session] - جلسة MongoDB
 */
const createEntry = async (data, session = null) => {
    const entry = new Ledger(data);
    await entry.save(session ? { session } : {});
    return entry;
};

/**
 * جلب كشف حساب لكيان محدد
 * @param {string} entityId
 * @param {Object} [dateRange] - { start, end }
 * @param {Object} [options] - { limit, skip, type }
 */
const getStatementForEntity = async (entityId, dateRange = {}, options = {}) => {
    const { limit = 100, skip = 0, type } = options;
    const filter = { entityId };

    if (dateRange.start || dateRange.end) {
        filter.createdAt = {};
        if (dateRange.start) filter.createdAt.$gte = dateRange.start;
        if (dateRange.end) filter.createdAt.$lte = dateRange.end;
    }

    if (type) filter.type = type;

    return Ledger.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
};

/**
 * حساب إجمالي الحركات حسب النوع
 * @param {string} entityId
 * @param {string} type - نوع الحركة (DEPOSIT, TRANSFER, REFUND, etc.)
 * @param {Object} [dateRange]
 */
const sumByType = async (entityId, type, dateRange = {}) => {
    const match = { entityId, type };
    if (dateRange.start || dateRange.end) {
        match.createdAt = {};
        if (dateRange.start) match.createdAt.$gte = dateRange.start;
        if (dateRange.end) match.createdAt.$lte = dateRange.end;
    }

    const result = await Ledger.aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    return result.length > 0
        ? { total: result[0].total, count: result[0].count }
        : { total: 0, count: 0 };
};

/**
 * التحقق من تطابق الرصيد المحسوب مع الرصيد الفعلي
 * (يُستخدم في المطابقة/Reconciliation)
 */
const calculateBalance = async (entityId) => {
    const result = await Ledger.aggregate([
        { $match: { entityId } },
        { $group: { _id: null, calculatedBalance: { $sum: '$amount' } } }
    ]);

    return result.length > 0 ? result[0].calculatedBalance : 0;
};

/**
 * جلب آخر قيد لكيان محدد
 */
const getLastEntry = async (entityId) => {
    return Ledger.findOne({ entityId })
        .sort({ createdAt: -1 })
        .lean();
};

module.exports = {
    createEntry,
    getStatementForEntity,
    sumByType,
    calculateBalance,
    getLastEntry
};
