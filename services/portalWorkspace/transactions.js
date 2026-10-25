'use strict';

const ClientEmployee = require('../../models/ClientEmployee');
const AgentEmployee = require('../../models/AgentEmployee');
const { buildAgentTransactionScope } = require('../agentTransactionScopeService');
const Transaction = require('../../models/Transaction');
const { pricingFromTransaction } = require('../../utils/agencyPricing');
const { STATUS_META, SERVICE_CATALOG } = require('./catalog');
const { escapeRegex, resolveDateRange, safeNumber } = require('./primitives');
const { systemDateKey, systemDayStart, systemDayEnd } = require('../../config/systemTime');

const ownershipFilter = async (workspace) => {
    if (workspace.isCompany) {
        const companyScope = { companyId: workspace.entity._id };
        if (!workspace.permissions.employee) return companyScope;
        // السجلات الجديدة تعتمد معرّف الموظف وليس الاسم. نُبقي توافقاً محدوداً
        // مع السجلات القديمة التي لا تحمل المعرّف حتى تُستكمل هجرتها.
        return {
            $and: [
                companyScope,
                {
                    $or: [
                        { clientActorId: String(workspace.actor._id) },
                        { clientActorId: { $exists: false }, employeeName: workspace.actor.name },
                    ],
                },
            ],
        };
    }

    return buildAgentTransactionScope({ agent: workspace.entity, actor: workspace.actor });
};

const buildTransactionFilter = async (workspace, query = {}, options = {}) => {
    let range = resolveDateRange(query, { forceToday: options.forceToday === true });
    if (workspace.isAgent && options.forceToday) {
        const today = systemDateKey(new Date());
        range = {
            start: systemDayStart(today),
            end: systemDayEnd(today),
            from: today,
            to: today,
            month: '',
            label: 'اليوم',
        };
    }
    const includeAllHistory = String(query.history || '') === 'all' && !options.forceToday;
    const conditions = [await ownershipFilter(workspace)];
    if (!includeAllHistory) conditions.push({ createdAt: { $gte: range.start, $lte: range.end } });
    const search = String(query.search || '').trim();

    if (search) {
        const regex = new RegExp(escapeRegex(search), 'i');
        const matches = {
            $or: [
                { customId: regex },
                { vodafoneNumber: regex },
                { accountNumber: regex },
                { accountName: regex },
                { employeeName: regex },
                { subAccountName: regex },
                { notes: regex },
            ],
        };
        const amount = Number(search.replace(/[,،\s]/g, ''));
        if (Number.isFinite(amount) && amount >= 0) matches.$or.push({ amount });
        conditions.push(matches);
    }
    if (query.status && STATUS_META[query.status]) conditions.push({ status: query.status });
    if (query.service && SERVICE_CATALOG.some((service) => service.key === query.service))
        conditions.push({ transferType: query.service });
    if (query.staff) conditions.push({ employeeName: String(query.staff).trim() });
    if (query.customer && /^[a-f\d]{24}$/i.test(String(query.customer)))
        conditions.push({ subAccountId: query.customer });

    return {
        filter: conditions.length === 1 ? conditions[0] : { $and: conditions },
        range,
        search,
        includeAllHistory,
    };
};

const summarizeTransactions = (transactions = []) =>
    transactions.reduce(
        (totals, tx) => {
            totals.totalCount += 1;
            const agencyProfit = tx.isSubAccountTx ? pricingFromTransaction(tx).profitLYD : 0;
            if (tx.status === 'completed') {
                totals.completedCount += 1;
                totals.totalEGP += safeNumber(tx.amount);
                totals.totalLYD += safeNumber(tx.costLYD);
                totals.realizedProfit += agencyProfit;
            } else if (['pending', 'processing', 'accepted'].includes(tx.status)) {
                totals.pendingCount += 1;
                totals.expectedProfit += agencyProfit;
            } else if (['rejected', 'cancelled_by_admin'].includes(tx.status)) {
                totals.cancelledCount += 1;
                totals.reversedProfit += agencyProfit;
            } else if (tx.status === 'deposit') {
                totals.depositTotal += safeNumber(tx.amount);
            } else if (tx.status === 'deduction') {
                totals.deductionTotal += safeNumber(tx.amount);
            }
            return totals;
        },
        {
            totalCount: 0,
            completedCount: 0,
            pendingCount: 0,
            cancelledCount: 0,
            totalEGP: 0,
            totalLYD: 0,
            depositTotal: 0,
            deductionTotal: 0,
            realizedProfit: 0,
            expectedProfit: 0,
            reversedProfit: 0,
        }
    );

const summarizeWithAggregation = async (filter) => {
    const rows = await Transaction.aggregate([
        { $match: filter },
        {
            $group: {
                _id: null,
                totalCount: { $sum: 1 },
                completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                pendingCount: {
                    $sum: { $cond: [{ $in: ['$status', ['pending', 'processing', 'accepted']] }, 1, 0] },
                },
                cancelledCount: {
                    $sum: { $cond: [{ $in: ['$status', ['rejected', 'cancelled_by_admin']] }, 1, 0] },
                },
                totalEGP: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                totalLYD: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$costLYD', 0] } },
                depositTotal: { $sum: { $cond: [{ $eq: ['$status', 'deposit'] }, '$amount', 0] } },
                deductionTotal: { $sum: { $cond: [{ $eq: ['$status', 'deduction'] }, '$amount', 0] } },
            },
        },
    ]);
    return rows[0] || summarizeTransactions([]);
};

const staffModelForWorkspace = (workspace) => (workspace.isCompany ? ClientEmployee : AgentEmployee);

const staffOwnerFilter = (workspace) =>
    workspace.isCompany
        ? { companyId: workspace.entity._id }
        : { agentId: workspace.entity._id, status: { $ne: 'deleted' } };

module.exports = {
    ownershipFilter,
    buildTransactionFilter,
    summarizeTransactions,
    summarizeWithAggregation,
    staffModelForWorkspace,
    staffOwnerFilter,
};
