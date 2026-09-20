'use strict';

const { applyAdminTxPrivacy } = require('./adminAccountVisibilityService');
const { adminAccountScope, tenantScope } = require('../utils/tenantScope');
const { systemDateKey, systemDateRange, systemDayStart } = require('../config/systemTime');

const SUCCESS_STATUS = 'completed';
const DAY_MS = 24 * 60 * 60 * 1000;

const emptyPeriodMetric = () => ({ count: 0, amountEGP: 0, costLYD: 0 });

const emptyPeriodStats = () => ({
    today: emptyPeriodMetric(),
    week: emptyPeriodMetric(),
    month: emptyPeriodMetric()
});

const shiftDateKey = (dateKey, days) => {
    const start = systemDayStart(dateKey);
    if (!start) return dateKey;
    return systemDateKey(new Date(start.getTime() + (days * DAY_MS)));
};

const successfulOpsPeriodBounds = (now = new Date()) => {
    const todayKey = systemDateKey(now);
    const weekStartKey = shiftDateKey(todayKey, -6);
    const monthStartKey = `${todayKey.slice(0, 7)}-01`;
    return {
        todayKey,
        weekStartKey,
        monthStartKey,
        today: systemDateRange(todayKey, todayKey),
        week: systemDateRange(weekStartKey, todayKey),
        month: systemDateRange(monthStartKey, todayKey)
    };
};

const successfulOpsLedgerMatch = (source) => applyAdminTxPrivacy({
    ...tenantScope(source),
    status: SUCCESS_STATUS,
    $and: [
        {
            $or: [
                { transferType: { $ne: 'balance_transfer' } },
                { customId: { $not: /-C$/ } }
            ]
        }
    ]
});

const fromFacetRow = (rows) => {
    const row = Array.isArray(rows) && rows[0] ? rows[0] : {};
    return {
        count: Number(row.count) || 0,
        amountEGP: Number(row.amountEGP) || 0,
        costLYD: Number(row.costLYD) || 0
    };
};

const periodMetricPipeline = (range) => ([
    ...(range ? [{ $match: { createdAt: range } }] : []),
    {
        $group: {
            _id: null,
            count: { $sum: 1 },
            amountEGP: { $sum: { $ifNull: ['$amount', 0] } },
            costLYD: { $sum: { $ifNull: ['$costLYD', 0] } }
        }
    }
]);

const loadSuccessfulOpsPeriodStats = async (Transaction, source, now = new Date()) => {
    const periods = successfulOpsPeriodBounds(now);
    const [facet] = await Transaction.aggregate([
        { $match: successfulOpsLedgerMatch(source) },
        {
            $facet: {
                today: periodMetricPipeline(periods.today),
                week: periodMetricPipeline(periods.week),
                month: periodMetricPipeline(periods.month)
            }
        }
    ]);
    const rows = facet || {};
    return {
        today: fromFacetRow(rows.today),
        week: fromFacetRow(rows.week),
        month: fromFacetRow(rows.month)
    };
};

const adminVisibleCompanyQuery = (source) => ({
    ...adminAccountScope(source),
    status: { $nin: ['deleted', 'inactive', 'archived'] }
});

const adminVisibleExecutorQuery = (source) => ({
    ...adminAccountScope(source),
    status: { $nin: ['deleted', 'archived'] },
    $or: [
        { balance: { $gt: 0 } },
        { isApiBot: true, lastApiServiceCredit: { $gt: 0 } },
        { isApiGroup: true, lastApiServiceCredit: { $gt: 0 } }
    ]
});

const mapActiveClientCompanies = (companies = []) => companies.map((company) => ({
    id: String(company._id),
    name: company.name || 'شركة بدون اسم',
    balance: Number(company.balance) || 0,
    accountCode: company.accountCode || '',
    phone: company.phone || ''
}));

const loadActiveClientCompanyBalances = async (ClientCompany, source) => {
    // Account widgets must not use applyAdminTxPrivacy — that filter is for
    // transaction ledgers (isSubAccountTx) and would be meaningless here.
    const companies = await ClientCompany.find(adminVisibleCompanyQuery(source))
        .select('name balance accountCode phone')
        .sort({ name: 1 })
        .lean();
    return mapActiveClientCompanies(companies);
};

const mapFundedExecutorBalances = (groups = []) => groups
    .map((group) => {
        const apiCredit = Number(group.lastApiServiceCredit);
        const internalBalance = Number(group.balance) || 0;
        const useApiCredit = Boolean(group.isApiBot || group.isApiGroup) && Number.isFinite(apiCredit) && apiCredit > 0;
        return {
            id: String(group._id),
            name: group.name || 'منفذ بدون اسم',
            balance: useApiCredit ? apiCredit : internalBalance,
            isManager: Boolean(group.isManagerBot || group.isManagerGroup),
            balanceSource: useApiCredit ? 'api_service' : 'internal',
            checkedAt: group.lastApiBalanceCheckAt || group.updatedAt || null
        };
    })
    .filter((group) => group.balance > 0)
    .sort((left, right) => right.balance - left.balance || String(left.name).localeCompare(String(right.name), 'ar'));

const loadFundedExecutorBalances = async (ExecutorGroup, source) => {
    const groups = await ExecutorGroup.find(adminVisibleExecutorQuery(source))
        .select('name balance isApiBot isApiGroup isManagerBot isManagerGroup lastApiServiceCredit lastApiBalanceCheckAt updatedAt')
        .lean();
    return mapFundedExecutorBalances(groups);
};

const loadCentralLedgerOverview = async ({
    Transaction,
    ClientCompany,
    ExecutorGroup,
    source,
    now = new Date()
}) => {
    const [periodStats, activeClientCompanies, fundedExecutorCompanies] = await Promise.all([
        loadSuccessfulOpsPeriodStats(Transaction, source, now),
        loadActiveClientCompanyBalances(ClientCompany, source),
        loadFundedExecutorBalances(ExecutorGroup, source)
    ]);
    return { periodStats, activeClientCompanies, fundedExecutorCompanies };
};

module.exports = {
    SUCCESS_STATUS,
    adminVisibleCompanyQuery,
    adminVisibleExecutorQuery,
    emptyPeriodStats,
    fromFacetRow,
    loadActiveClientCompanyBalances,
    loadCentralLedgerOverview,
    loadFundedExecutorBalances,
    loadSuccessfulOpsPeriodStats,
    mapActiveClientCompanies,
    mapFundedExecutorBalances,
    successfulOpsLedgerMatch,
    successfulOpsPeriodBounds
};
