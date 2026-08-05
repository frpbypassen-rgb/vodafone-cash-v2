// services/settlementService.js
// ===============================================
// 💰 خدمة التسويات المحاسبية — Settlement Engine
// ===============================================
'use strict';

const Settlement = require('../models/Settlement');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Settings = require('../models/Settings');
const logger = require('../utils/logger');

const DAILY_OPERATION_STATUSES = [
    'completed',
    'rejected',
    'cancelled_by_admin',
    'pending',
    'processing',
    'accepted',
    'deposit',
    'deduction',
    'deposit_pending'
];

const getDayBounds = (date = new Date()) => {
    const value = new Date(date);
    if (Number.isNaN(value.getTime())) throw new Error('INVALID_SETTLEMENT_DATE');
    const start = new Date(value);
    start.setHours(0, 0, 0, 0);
    const end = new Date(value);
    end.setHours(23, 59, 59, 999);
    return { start, end };
};

const parseClosingTime = (value) => {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return { hours: 23, minutes: 0 };
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return { hours: 23, minutes: 0 };
    return { hours, minutes };
};

const configuredClosingTime = async () => {
    const settings = await Settings.findOne().select('closingTime').lean().catch(() => null);
    return parseClosingTime(settings?.closingTime);
};

/**
 * توليد تسوية يومية
 * @param {Date} date - التاريخ المطلوب
 * @returns {Promise<Object>} التسوية المنشأة
 */
const generateDailySettlement = async (date = new Date(), options = {}) => {
    const { start: startOfDay, end: endOfDay } = getDayBounds(date);

    try {
        // التحقق من عدم وجود تسوية مكررة
        const existing = await Settlement.findOne({
            type: 'daily',
            entityType: 'system',
            'period.start': startOfDay
        });
        if (existing?.status === 'closed' && existing.closedAt) return existing;

        // جمع بيانات العمليات لليوم
        const transactions = await Transaction.find({
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            status: { $in: DAILY_OPERATION_STATUSES }
        }).lean();

        const completed = transactions.filter(t => t.status === 'completed');
        const cancelled = transactions.filter(t => t.status === 'rejected' || t.status === 'cancelled_by_admin');
        const pending = transactions.filter(t => ['pending', 'processing', 'accepted', 'deposit_pending'].includes(t.status));
        const deposits = transactions.filter(t => t.status === 'deposit');
        const deductions = transactions.filter(t => t.status === 'deduction');

        // أنواع التحويلات الناجحة فقط؛ الملغية لا تدخل في أي إجمالي مالي.
        const transferTypes = {};
        for (const tx of completed) {
            const type = tx.transferType || 'unknown';
            if (!transferTypes[type]) transferTypes[type] = { count: 0, amount: 0 };
            transferTypes[type].count++;
            transferTypes[type].amount += tx.amount || 0;
        }

        const totalAmountEGP = completed.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
        const totalCostLYD = completed.reduce((sum, t) => sum + (t.costLYD || 0), 0);
        const totalRefunds = cancelled.reduce((sum, t) => sum + (t.costLYD || 0), 0);
        const totalDeposits = deposits.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
        const totalDeductions = deductions.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);
        const netMovement = totalDeposits - totalDeductions - totalCostLYD;
        const closedAt = options.closedAt ? new Date(options.closedAt) : new Date(endOfDay.getTime() + 1);

        const settlementData = {
            period: { start: startOfDay, end: endOfDay },
            type: 'daily',
            entityType: 'system',
            entityName: 'Al-Ahram Pay System',
            summary: {
                totalTransactions: transactions.length,
                totalAmountEGP,
                totalCostLYD,
                totalCommission: 0,
                totalRefunds,
                netAmount: netMovement,
                completedCount: completed.length,
                cancelledCount: cancelled.length,
                pendingCount: pending.length
            },
            details: {
                deposits: totalDeposits,
                deductions: totalDeductions,
                netMovement,
                transferTypes
            },
            status: 'closed',
            closedAt,
            closedByName: options.closedByName || 'الإقفال المالي الآلي',
            approvedAt: closedAt,
            approvedByName: options.closedByName || 'الإقفال المالي الآلي',
            notes: 'تم إقفال حسابات اليوم آلياً. أي تعديل لاحق يظهر في سجل ملاحظات ما بعد الإقفال.'
        };
        const settlement = existing || new Settlement(settlementData);
        if (existing) existing.set(settlementData);

        try {
            await settlement.save();
        } catch (error) {
            if (error?.code === 11000) {
                return Settlement.findOne({
                    type: 'daily',
                    entityType: 'system',
                    'period.start': startOfDay
                });
            }
            throw error;
        }
        logger.financial('Daily settlement generated', {
            date: `${startOfDay.getFullYear()}-${String(startOfDay.getMonth() + 1).padStart(2, '0')}-${String(startOfDay.getDate()).padStart(2, '0')}`,
            transactions: transactions.length,
            totalEGP: totalAmountEGP,
            totalLYD: totalCostLYD,
            deposits: totalDeposits,
            deductions: totalDeductions
        });

        return settlement;
    } catch (error) {
        logger.error('Failed to generate daily settlement', { error: error.message, date });
        throw error;
    }
};

const ensureDailySettlements = async (startDate, endDate, options = {}) => {
    const now = options.now ? new Date(options.now) : new Date();
    const { start } = getDayBounds(startDate);
    const { end } = getDayBounds(endDate);
    const closing = options.closingTime || await configuredClosingTime();
    const results = [];

    for (let cursor = new Date(start), guard = 0; cursor <= end && guard < 370; guard += 1) {
        const day = new Date(cursor);
        const scheduledClose = new Date(day);
        scheduledClose.setHours(closing.hours, closing.minutes, 0, 0);

        if (scheduledClose <= now) {
            results.push(await generateDailySettlement(day, {
                closedAt: scheduledClose,
                closedByName: options.closedByName || 'الإقفال المالي الآلي'
            }));
        }

        cursor.setDate(cursor.getDate() + 1);
    }

    return results.filter(Boolean);
};

const closeEligibleDailySettlement = async (now = new Date()) => {
    const today = new Date(now);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return ensureDailySettlements(yesterday, today, { now });
};

/**
 * توليد تسوية لمنفذ محدد
 */
const generateExecutorSettlement = async (executorBotId, startDate, endDate) => {
    try {
        const executorBot = await ExecutorGroup.findById(executorBotId);
        if (!executorBot) throw new Error('EXECUTOR_NOT_FOUND');

        const transactions = await Transaction.find({
            executorBotId,
            status: 'completed',
            createdAt: { $gte: startDate, $lte: endDate }
        }).lean();

        const totalAmountEGP = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);

        const settlement = new Settlement({
            period: { start: startDate, end: endDate },
            type: 'custom',
            entityType: 'executor',
            entityId: executorBotId,
            entityName: executorBot.name,
            summary: {
                totalTransactions: transactions.length,
                totalAmountEGP,
                completedCount: transactions.length,
                netAmount: totalAmountEGP
            },
            details: {
                openingBalance: executorBot.balance + totalAmountEGP,
                closingBalance: executorBot.balance
            },
            status: 'draft'
        });

        await settlement.save();
        return settlement;
    } catch (error) {
        logger.error('Failed to generate executor settlement', { error: error.message });
        throw error;
    }
};

/**
 * اعتماد تسوية
 */
const approveSettlement = async (settlementId, adminId, adminName) => {
    return Settlement.findByIdAndUpdate(settlementId, {
        $set: {
            status: 'approved',
            approvedBy: adminId,
            approvedByName: adminName,
            approvedAt: new Date()
        }
    }, { new: true });
};

/**
 * جلب تسويات بفلاتر
 */
const getSettlements = async (filters = {}, options = {}) => {
    const { limit = 20, skip = 0 } = options;
    return Settlement.find(filters)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
};

module.exports = {
    closeEligibleDailySettlement,
    ensureDailySettlements,
    generateDailySettlement,
    generateExecutorSettlement,
    approveSettlement,
    getDayBounds,
    getSettlements,
    parseClosingTime
};
