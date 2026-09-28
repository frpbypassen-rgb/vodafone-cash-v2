'use strict';

const ClientCompany = require('../models/ClientCompany');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { SYSTEM_TIME_ZONE, systemDateKey, systemDateParts } = require('../config/systemTime');
const { resolveReportScope } = require('./adminReportService');
const { applyAdminTxPrivacy } = require('./adminAccountVisibilityService');
const { adminAccountScope, tenantScope } = require('../utils/tenantScope');

const SUCCESS_STATUS = 'completed';
const CANCELLED_STATUSES = ['rejected', 'cancelled_by_admin'];
const DAY_MS = 24 * 60 * 60 * 1000;

const zonedBoundary = (dateKey, end = false) => {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const hour = end ? 23 : 0;
    const minute = end ? 59 : 0;
    const second = end ? 59 : 0;
    const millisecond = end ? 999 : 0;
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    const zoneParts = systemDateParts(utcGuess);
    const representedAsUtc = Date.UTC(
        Number(zoneParts.year), Number(zoneParts.month) - 1, Number(zoneParts.day),
        Number(zoneParts.hour), Number(zoneParts.minute), Number(zoneParts.second), millisecond
    );
    return new Date(utcGuess.getTime() - (representedAsUtc - utcGuess.getTime()));
};

const startOfDay = (value = new Date()) => zonedBoundary(systemDateKey(value));
const endOfDay = (value = new Date()) => zonedBoundary(systemDateKey(value), true);

const addDays = (value, days) => new Date(new Date(value).getTime() + (days * DAY_MS));

const monthStart = (value = new Date()) => {
    const parts = systemDateParts(value);
    return zonedBoundary(`${parts.year}-${parts.month}-01`);
};

const percentageChange = (current, previous) => {
    const safeCurrent = Number(current) || 0;
    const safePrevious = Number(previous) || 0;
    if (!safePrevious) return safeCurrent ? 100 : 0;
    return Math.round(((safeCurrent - safePrevious) / safePrevious) * 1000) / 10;
};

const emptyMetric = () => ({ count: 0, amountEGP: 0, costLYD: 0, profitLYD: 0 });

const completedInRange = (start, end) => ({
    $or: [
        { completedAt: { $gte: start, $lte: end } },
        { $and: [
            { $or: [{ completedAt: { $exists: false } }, { completedAt: null }] },
            { createdAt: { $gte: start, $lte: end } }
        ] }
    ]
});

const metricFacet = (start, end) => [
    { $match: completedInRange(start, end) },
    {
        $group: {
            _id: null,
            count: { $sum: 1 },
            amountEGP: { $sum: { $ifNull: ['$amount', 0] } },
            costLYD: { $sum: { $ifNull: ['$costLYD', 0] } },
            profitLYD: { $sum: { $ifNull: ['$masterProfit', 0] } }
        }
    }
];

const normalizeMetric = (rows) => {
    const row = Array.isArray(rows) && rows[0] ? rows[0] : {};
    return {
        count: Number(row.count) || 0,
        amountEGP: Number(row.amountEGP) || 0,
        costLYD: Number(row.costLYD) || 0,
        profitLYD: Number(row.profitLYD) || 0
    };
};

const buildPeriods = (now = new Date()) => {
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const yesterdayStart = addDays(todayStart, -1);
    const yesterdayEquivalentEnd = new Date(Math.min(
        endOfDay(yesterdayStart).getTime(),
        yesterdayStart.getTime() + (now.getTime() - todayStart.getTime())
    ));
    const weekStart = addDays(todayStart, -6);
    const previousWeekStart = addDays(weekStart, -7);
    const previousWeekEnd = new Date(weekStart.getTime() - 1);
    const currentMonthStart = monthStart(now);
    const currentParts = systemDateParts(currentMonthStart);
    const previousMonthAnchor = new Date(Date.UTC(Number(currentParts.year), Number(currentParts.month) - 2, 15));
    const previousMonthParts = systemDateParts(previousMonthAnchor);
    const previousMonthStart = zonedBoundary(`${previousMonthParts.year}-${previousMonthParts.month}-01`);
    const previousMonthEnd = new Date(currentMonthStart.getTime() - 1);

    return {
        now,
        todayStart,
        todayEnd,
        yesterdayStart,
        yesterdayEquivalentEnd,
        weekStart,
        previousWeekStart,
        previousWeekEnd,
        currentMonthStart,
        previousMonthStart,
        previousMonthEnd,
        historyStart: addDays(todayStart, -55)
    };
};

const fillDailySeries = (rows, start, days) => {
    const rowMap = new Map((rows || []).map((row) => [row._id, row]));
    return Array.from({ length: days }, (_, index) => {
        const date = addDays(start, index);
        const key = systemDateKey(date);
        const row = rowMap.get(key) || {};
        return {
            date: key,
            label: new Intl.DateTimeFormat('ar', { timeZone: SYSTEM_TIME_ZONE, weekday: 'short', day: 'numeric' }).format(date),
            count: Number(row.count) || 0,
            amountEGP: Number(row.amountEGP) || 0,
            costLYD: Number(row.costLYD) || 0
        };
    });
};

const buildInsights = ({ metrics, weekly, peakDays, executors, todayStatus, now = new Date() }) => {
    const insights = [];
    const strongest = [...(weekly || [])].sort((a, b) => b.amountEGP - a.amountEGP)[0];
    const weakest = [...(weekly || [])].sort((a, b) => a.amountEGP - b.amountEGP)[0];
    const bestExecutor = executors && executors[0];
    const pending = Number(todayStatus.pending) + Number(todayStatus.processing);

    if (metrics.today.amountEGP || metrics.yesterday.amountEGP) {
        const change = percentageChange(metrics.today.amountEGP, metrics.yesterday.amountEGP);
        insights.push({
            level: change >= 0 ? 'positive' : 'warning',
            icon: change >= 0 ? 'arrow-trend-up' : 'arrow-trend-down',
            title: change >= 0 ? 'نشاط اليوم أعلى من المعتاد' : 'نشاط اليوم أقل من أمس',
            text: `${Math.abs(change)}% ${change >= 0 ? 'زيادة' : 'انخفاض'} في قيمة العمليات الناجحة مقارنة بنفس الوقت أمس.`
        });
    }
    if (strongest && strongest.amountEGP > 0) {
        insights.push({
            level: 'info', icon: 'calendar-check', title: 'أقوى يوم هذا الأسبوع',
            text: `${strongest.label} سجل ${strongest.amountEGP.toLocaleString('en-US')} ج.م عبر ${strongest.count} عملية ناجحة.`
        });
    }
    if (peakDays && peakDays[0]) {
        insights.push({
            level: 'gold', icon: 'bolt', title: 'نمط ذروة متكرر',
            text: `${peakDays[0].weekdayLabel} هو الأقوى خلال آخر 8 أسابيع بمتوسط ${Math.round(peakDays[0].averageAmountEGP).toLocaleString('en-US')} ج.م يوميًا.`
        });
    }
    if (bestExecutor) {
        insights.push({
            level: 'positive', icon: 'medal', title: 'المنفذ الأعلى كفاءة',
            text: `${bestExecutor.name} يتصدر بدرجة ${bestExecutor.efficiencyScore}% ونسبة نجاح ${bestExecutor.successRate}%.`
        });
    }
    if (pending > 0) {
        insights.push({
            level: pending > Math.max(10, metrics.today.count * 0.25) ? 'warning' : 'info',
            icon: 'hourglass-half', title: 'عمليات تحتاج متابعة',
            text: `${pending} عملية معلقة أو قيد التنفيذ اليوم.`
        });
    }
    if (!insights.length) {
        insights.push({ level: 'info', icon: 'circle-info', title: 'في انتظار بيانات كافية', text: 'ستظهر الاستنتاجات الذكية تلقائيًا بعد تسجيل العمليات.' });
    }
    return insights.slice(0, 5).map((item) => ({ ...item, generatedAt: now }));
};

const loadDashboardIntelligence = async (now = new Date(), { tenantId = null } = {}) => {
    const periods = buildPeriods(now);
    const scopedTenant = applyAdminTxPrivacy(tenantScope(tenantId));
    const facet = {
        today: metricFacet(periods.todayStart, now),
        yesterday: metricFacet(periods.yesterdayStart, periods.yesterdayEquivalentEnd),
        week: metricFacet(periods.weekStart, now),
        previousWeek: metricFacet(periods.previousWeekStart, periods.previousWeekEnd),
        month: metricFacet(periods.currentMonthStart, now),
        previousMonth: metricFacet(periods.previousMonthStart, periods.previousMonthEnd)
    };

    const [metricRows, weeklyRows, peakRows, executorRows, statusRows] = await Promise.all([
        Transaction.aggregate([{
            $match: {
                ...scopedTenant,
                status: SUCCESS_STATUS,
                createdAt: { $gte: periods.previousMonthStart, $lte: now }
            }
        }, { $facet: facet }]),
        Transaction.aggregate([
            { $match: { ...scopedTenant, status: SUCCESS_STATUS, createdAt: { $gte: periods.weekStart, $lte: now } } },
            { $set: { dashboardCompletedAt: { $ifNull: ['$completedAt', '$createdAt'] } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$dashboardCompletedAt', timezone: SYSTEM_TIME_ZONE } }, count: { $sum: 1 }, amountEGP: { $sum: '$amount' }, costLYD: { $sum: '$costLYD' } } },
            { $sort: { _id: 1 } }
        ]),
        Transaction.aggregate([
            { $match: { ...scopedTenant, status: SUCCESS_STATUS, createdAt: { $gte: periods.historyStart, $lte: now } } },
            { $set: { dashboardCompletedAt: { $ifNull: ['$completedAt', '$createdAt'] } } },
            { $group: { _id: { $dayOfWeek: { date: '$dashboardCompletedAt', timezone: SYSTEM_TIME_ZONE } }, totalAmountEGP: { $sum: '$amount' }, totalOperations: { $sum: 1 }, activeDays: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$dashboardCompletedAt', timezone: SYSTEM_TIME_ZONE } } } } },
            { $project: { totalAmountEGP: 1, totalOperations: 1, activeDayCount: { $size: '$activeDays' }, averageAmountEGP: { $divide: ['$totalAmountEGP', { $max: [{ $size: '$activeDays' }, 1] }] } } },
            { $sort: { averageAmountEGP: -1 } }
        ]),
        Transaction.aggregate([
            { $match: { ...scopedTenant, createdAt: { $gte: periods.currentMonthStart, $lte: now }, executorGroupId: { $ne: null }, status: { $nin: ['deposit', 'deposit_pending', 'deduction'] } } },
            { $group: {
                _id: '$executorGroupId',
                name: { $last: '$executorGroupName' },
                total: { $sum: 1 },
                completed: { $sum: { $cond: [{ $eq: ['$status', SUCCESS_STATUS] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $in: ['$status', CANCELLED_STATUSES] }, 1, 0] } },
                monthAmountEGP: { $sum: { $cond: [{ $eq: ['$status', SUCCESS_STATUS] }, '$amount', 0] } },
                todayAmountEGP: { $sum: { $cond: [{ $and: [{ $eq: ['$status', SUCCESS_STATUS] }, { $gte: [{ $ifNull: ['$completedAt', '$createdAt'] }, periods.todayStart] }] }, '$amount', 0] } },
                averageMinutes: { $avg: { $cond: [{ $and: [{ $eq: ['$status', SUCCESS_STATUS] }, { $ne: ['$completedAt', null] }, { $ne: ['$executorReceivedAt', null] }] }, { $divide: [{ $subtract: ['$completedAt', '$executorReceivedAt'] }, 60000] }, null] } },
                rating: { $avg: '$executorRating' }
            } },
            { $sort: { monthAmountEGP: -1 } },
            { $limit: 12 }
        ]),
        Transaction.aggregate([
            { $match: { ...scopedTenant, createdAt: { $gte: periods.todayStart, $lte: now } } },
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ])
    ]);

    const rawMetrics = metricRows[0] || {};
    const metrics = {
        today: normalizeMetric(rawMetrics.today),
        yesterday: normalizeMetric(rawMetrics.yesterday),
        week: normalizeMetric(rawMetrics.week),
        previousWeek: normalizeMetric(rawMetrics.previousWeek),
        month: normalizeMetric(rawMetrics.month),
        previousMonth: normalizeMetric(rawMetrics.previousMonth)
    };
    metrics.today.change = percentageChange(metrics.today.amountEGP, metrics.yesterday.amountEGP);
    metrics.week.change = percentageChange(metrics.week.amountEGP, metrics.previousWeek.amountEGP);
    metrics.month.change = percentageChange(metrics.month.amountEGP, metrics.previousMonth.amountEGP);

    const weekdayLabels = { 1: 'الأحد', 2: 'الاثنين', 3: 'الثلاثاء', 4: 'الأربعاء', 5: 'الخميس', 6: 'الجمعة', 7: 'السبت' };
    const peakDays = peakRows.map((row) => ({ ...row, weekdayLabel: weekdayLabels[row._id] || '---' })).slice(0, 4);
    const executors = executorRows.map((row) => {
        const successRate = row.total ? Math.round((row.completed / row.total) * 1000) / 10 : 0;
        const speedScore = row.averageMinutes == null ? 50 : Math.max(0, Math.min(100, 100 - (Number(row.averageMinutes) * 2)));
        const ratingScore = row.rating == null ? 60 : (Number(row.rating) / 5) * 100;
        const efficiencyScore = Math.round((successRate * 0.6) + (speedScore * 0.25) + (ratingScore * 0.15));
        return {
            id: String(row._id),
            name: row.name || 'منفذ غير مسمى',
            total: row.total,
            completed: row.completed,
            failed: row.failed,
            monthAmountEGP: Number(row.monthAmountEGP) || 0,
            todayAmountEGP: Number(row.todayAmountEGP) || 0,
            averageMinutes: row.averageMinutes == null ? null : Math.round(Number(row.averageMinutes) * 10) / 10,
            rating: row.rating == null ? null : Math.round(Number(row.rating) * 10) / 10,
            successRate,
            efficiencyScore
        };
    }).sort((left, right) => right.efficiencyScore - left.efficiencyScore);
    const todayStatus = { pending: 0, processing: 0, completed: 0, cancelled: 0 };
    statusRows.forEach((row) => {
        if (row._id === 'pending') todayStatus.pending += row.count;
        else if (['processing', 'accepted'].includes(row._id)) todayStatus.processing += row.count;
        else if (row._id === SUCCESS_STATUS) todayStatus.completed += row.count;
        else if (CANCELLED_STATUSES.includes(row._id)) todayStatus.cancelled += row.count;
    });

    const weekly = fillDailySeries(weeklyRows, periods.weekStart, 7);
    return {
        metrics,
        weekly,
        peakDays,
        executors,
        todayStatus,
        insights: buildInsights({ metrics, weekly, peakDays, executors, todayStatus, now }),
        generatedAt: now
    };
};

const listDashboardEntities = async ({ type, search = '', limit = 100, tenantId = null }) => {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const regex = search ? new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const visible = { status: { $ne: 'deleted' } };
    const scopedTenant = adminAccountScope(tenantId);
    let rows = [];

    if (type === 'client') {
        rows = await User.find({ ...scopedTenant, ...visible, role: { $ne: 'agent' }, ...(regex ? { $or: [{ name: regex }, { phone: regex }, { accountCode: regex }] } : {}) }).select('name phone accountCode').sort({ name: 1 }).limit(safeLimit).lean();
    } else if (type === 'agent') {
        rows = await User.find({ ...scopedTenant, ...visible, role: 'agent', ...(regex ? { $or: [{ name: regex }, { phone: regex }, { accountCode: regex }, { agentCode: regex }] } : {}) }).select('name phone accountCode agentCode').sort({ name: 1 }).limit(safeLimit).lean();
    } else if (type === 'company') {
        rows = await ClientCompany.find({ ...scopedTenant, ...visible, ...(regex ? { $or: [{ name: regex }, { phone: regex }, { accountCode: regex }] } : {}) }).select('name phone accountCode').sort({ name: 1 }).limit(safeLimit).lean();
    } else if (type === 'executor') {
        rows = await ExecutorGroup.find({ ...scopedTenant, status: { $ne: 'archived' }, ...(regex ? { name: regex } : {}) }).select('name serviceKey').sort({ name: 1 }).limit(safeLimit).lean();
    } else {
        throw new Error('INVALID_ENTITY_TYPE');
    }
    return rows.map((row) => ({
        id: String(row._id),
        name: row.name || '---',
        detail: row.phone || row.accountCode || row.agentCode || row.serviceKey || '',
        kind: type
    }));
};

const entityCategory = (type) => ({ client: 'direct_client', company: 'company', agent: 'agent', executor: 'executor' }[type]);

const loadEntityMovementReport = async ({ type, id, days = 30, now = new Date(), tenantId = null }) => {
    const category = entityCategory(type);
    if (!category || !id) throw new Error('INVALID_ENTITY_SCOPE');
    const safeDays = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
    const start = startOfDay(addDays(now, -(safeDays - 1)));
    const scope = await resolveReportScope({ mainCategory: category, subId: id, subType: 'all', tenantId });
    const baseQuery = applyAdminTxPrivacy({
        ...scope.baseQuery,
        ...adminAccountScope(tenantId),
        createdAt: { $gte: start, $lte: now }
    });
    const [summaryRows, trendRows, recent] = await Promise.all([
        Transaction.aggregate([
            { $match: baseQuery },
            { $group: {
                _id: null,
                total: { $sum: 1 },
                completed: { $sum: { $cond: [{ $eq: ['$status', SUCCESS_STATUS] }, 1, 0] } },
                pending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'processing', 'accepted']] }, 1, 0] } },
                cancelled: { $sum: { $cond: [{ $in: ['$status', CANCELLED_STATUSES] }, 1, 0] } },
                amountEGP: { $sum: { $cond: [{ $eq: ['$status', SUCCESS_STATUS] }, '$amount', 0] } },
                costLYD: { $sum: { $cond: [{ $eq: ['$status', SUCCESS_STATUS] }, '$costLYD', 0] } },
                profitLYD: { $sum: { $cond: [{ $eq: ['$status', SUCCESS_STATUS] }, '$masterProfit', 0] } },
                averageAmountEGP: { $avg: { $cond: [{ $eq: ['$status', SUCCESS_STATUS] }, '$amount', null] } }
            } }
        ]),
        Transaction.aggregate([
            { $match: { ...baseQuery, status: SUCCESS_STATUS } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$completedAt', '$createdAt'] }, timezone: SYSTEM_TIME_ZONE } }, count: { $sum: 1 }, amountEGP: { $sum: '$amount' } } },
            { $sort: { _id: 1 } }
        ]),
        Transaction.find(baseQuery).select('customId status amount costLYD transferType createdAt completedAt executorGroupName executorName companyName employeeName').sort({ createdAt: -1 }).limit(12).lean()
    ]);
    const summary = { ...emptyMetric(), total: 0, completed: 0, pending: 0, cancelled: 0, averageAmountEGP: 0, ...(summaryRows[0] || {}) };
    delete summary._id;
    return {
        entity: scope.entityInfo,
        type,
        days: safeDays,
        summary,
        trend: fillDailySeries(trendRows, start, safeDays),
        recent: recent.map((row) => ({
            id: String(row._id), customId: row.customId, status: row.status, amountEGP: row.amount || 0, costLYD: row.costLYD || 0,
            transferType: row.transferType, createdAt: row.createdAt, completedAt: row.completedAt,
            counterparty: type === 'executor' ? (row.companyName || row.employeeName || 'عميل') : (row.executorGroupName || row.executorName || 'غير موجه')
        }))
    };
};

module.exports = {
    buildInsights,
    buildPeriods,
    completedInRange,
    fillDailySeries,
    listDashboardEntities,
    loadDashboardIntelligence,
    loadEntityMovementReport,
    percentageChange
};
