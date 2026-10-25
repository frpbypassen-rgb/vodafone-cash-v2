'use strict';
const base = require('./operationsSummaryStripService');
const { applyAdminTxPrivacy } = require('./adminAccountVisibilityService');
const { adminAccountScope } = require('../utils/tenantScope');
const { successfulOpsPeriodBounds } = require('./centralLedgerOverviewService');

async function loadOperationsSummaryStrip(options) {
    const { Transaction, source, now = new Date() } = options;
    const periods = successfulOpsPeriodBounds(now);
    const scope = applyAdminTxPrivacy({ ...adminAccountScope(source) });
    const completed = { status: 'completed', transferType: { $ne: 'balance_transfer' } };
    const completedRange = range => ({ $or: [{ completedAt: range }, { completedAt: null, createdAt: range }] });
    const dayTransaction = { aggregate: pipeline => {
        delete pipeline[0].$match.createdAt;
        pipeline[0].$match.$and = [...(pipeline[0].$match.$and || []), { $or: [
            { status: 'completed', ...completedRange(periods.today) },
            { status: 'deposit', createdAt: periods.today }
        ] }];
        return Transaction.aggregate(pipeline);
    } };
    const count = (match) => [{ $match: match }, { $count: 'count' }];
    const [summary, activityRows, countRows] = await Promise.all([
        base.loadOperationsSummaryStrip({ ...options, Transaction: dayTransaction }),
        Transaction.aggregate([
            { $match: { ...scope, transferType: { $ne: 'balance_transfer' }, $or: [{ createdAt: periods.today }, { completedAt: periods.today }, { status: { $in: ['pending', 'processing', 'accepted'] } }] } },
            { $facet: {
                companies: [{ $match: { companyId: { $ne: null } } }, { $group: { _id: '$companyId', count: { $sum: 1 } } }],
                executors: [{ $match: { executorGroupId: { $ne: null } } }, { $group: { _id: '$executorGroupId', count: { $sum: 1 } } }]
            } }
        ]),
        Transaction.aggregate([{ $match: scope }, { $facet: {
            today: count({ ...completed, ...completedRange(periods.today) }),
            cancelled: count({ status: 'cancelled_by_admin', $or: [{ cancelledAt: periods.today }, { cancelledAt: null, createdAt: periods.today }], transferType: { $ne: 'balance_transfer' } }),
            week: count({ ...completed, ...completedRange(periods.week) }),
            month: count({ ...completed, ...completedRange(periods.month) }),
            total: count(completed)
        } }])
    ]);
    const activity = activityRows[0] || {};
    for (const [key, rows] of [['companies', activity.companies], ['activeExecutors', activity.executors]]) {
        const counts = new Map((rows || []).map(row => [String(row._id), row.count]));
        summary[key] = (summary[key] || []).map(row => ({ ...row, activityCount: counts.get(row.id) || 0 }));
    }
    summary.counts = Object.fromEntries(['today', 'cancelled', 'week', 'month', 'total'].map(key => [key, Number(countRows[0]?.[key]?.[0]?.count) || 0]));
    return summary;
}
module.exports = { loadOperationsSummaryStrip };
