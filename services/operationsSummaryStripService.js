'use strict';

const { applyAdminTxPrivacy } = require('./adminAccountVisibilityService');
const { adminAccountScope } = require('../utils/tenantScope');
const { snapshotServiceLedgers } = require('../utils/executorServiceLedger');
const {
    loadActiveClientCompanyBalances,
    successfulOpsPeriodBounds
} = require('./centralLedgerOverviewService');

const COMPLETED_STATUS = 'completed';
const DEPOSIT_STATUS = 'deposit';

const emptyOperationsSummary = () => ({
    today: { egyptianEGP: 0, libyanLYD: 0 },
    todayDepositsTotal: 0,
    activeExecutors: [],
    companies: []
});

const balanceTransferCounterpartExclusion = () => ({
    $or: [
        { transferType: { $ne: 'balance_transfer' } },
        { customId: { $not: /-C$/ } }
    ]
});

const indexAggregation = (rows, valueKey) => {
    const map = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
        if (!row || row._id == null) return;
        map.set(String(row._id), Number(row[valueKey]) || 0);
    });
    return map;
};

// One scan of today's completed transfers and company deposits. The
// balance-transfer counterpart (-C) is excluded so an internal move is
// not counted twice. Company deposits stay on status=deposit with a
// companyId, matching the admin deposits ledger.
const buildOperationsDayFacetPipeline = (source, now = new Date()) => {
    const today = successfulOpsPeriodBounds(now).today;
    return [
        {
            $match: applyAdminTxPrivacy({
                ...adminAccountScope(source),
                ...(today ? { createdAt: today } : {}),
                status: { $in: [COMPLETED_STATUS, DEPOSIT_STATUS] }
            })
        },
        {
            $facet: {
                totals: [
                    { $match: { status: COMPLETED_STATUS, ...balanceTransferCounterpartExclusion() } },
                    {
                        $group: {
                            _id: null,
                            egyptianEGP: { $sum: { $ifNull: ['$amount', 0] } },
                            libyanLYD: { $sum: { $ifNull: ['$costLYD', 0] } }
                        }
                    }
                ],
                completedByCompany: [
                    {
                        $match: {
                            status: COMPLETED_STATUS,
                            companyId: { $exists: true, $ne: null },
                            ...balanceTransferCounterpartExclusion()
                        }
                    },
                    { $group: { _id: '$companyId', count: { $sum: 1 } } }
                ],
                depositsByCompany: [
                    {
                        $match: {
                            status: DEPOSIT_STATUS,
                            companyId: { $exists: true, $ne: null }
                        }
                    },
                    { $group: { _id: '$companyId', total: { $sum: { $ifNull: ['$amount', 0] } } } }
                ]
            }
        }
    ];
};

const activeExecutorStripQuery = (source) => ({
    ...adminAccountScope(source),
    status: 'active',
    isManagerBot: { $ne: true },
    isManagerGroup: { $ne: true },
    $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }]
});

const manualTotalBalance = (group, allocatedBalance) => {
    const snapshot = snapshotServiceLedgers({
        group,
        allocatedBalance: Number(allocatedBalance) || 0
    });
    const rows = Array.isArray(snapshot.byService) ? snapshot.byService : [];
    if (!rows.length) return Number(snapshot.totalBalance) || 0;
    return rows.reduce((sum, row) => sum + (Number(row.totalBalance) || 0), 0);
};

// Active routing executors, each with the balance currently held with
// them: private service wallets plus allocated pools. API executors use
// the last cached provider credit instead of a live provider call.
const mapActiveExecutorStrip = (groups = [], allocatedByGroup = new Map()) => groups
    .map((group) => {
        const id = String(group._id);
        const isApi = Boolean(group.isApiBot || group.isApiGroup);
        const cachedCredit = Number(group.lastApiServiceCredit);
        const hasCachedCredit = isApi
            && group.lastApiServiceCredit != null
            && group.lastApiServiceCredit !== ''
            && Number.isFinite(cachedCredit);
        const allocated = allocatedByGroup.get(id) || 0;
        const balance = hasCachedCredit ? cachedCredit : manualTotalBalance(group, isApi ? 0 : allocated);
        return {
            id,
            name: group.name || 'منفذ بدون اسم',
            balance,
            balanceSource: hasCachedCredit ? 'api_service' : 'internal'
        };
    })
    .sort((left, right) => right.balance - left.balance || String(left.name).localeCompare(String(right.name), 'ar'));

const mapCompanyStrip = (companies = [], completedByCompany = new Map(), depositsByCompany = new Map()) => (
    companies.map((company) => ({
        id: String(company.id || company._id),
        name: company.name || 'شركة بدون اسم',
        balance: Number(company.balance) || 0,
        completedToday: completedByCompany.get(String(company.id || company._id)) || 0,
        depositsToday: depositsByCompany.get(String(company.id || company._id)) || 0
    }))
);

const sumValues = (rows, key) => (Array.isArray(rows) ? rows : [])
    .reduce((sum, row) => sum + (Number(row[key]) || 0), 0);

const loadAllocatedBalances = async (groupIds) => {
    try {
        const { loadAllocatedByGroupIds } = require('./executorBalancePoolService');
        return await loadAllocatedByGroupIds(groupIds);
    } catch (_) {
        return new Map();
    }
};

const loadOperationsSummaryStrip = async ({
    Transaction,
    ClientCompany,
    ExecutorGroup,
    source,
    now = new Date()
}) => {
    const [facetRows, companies, executors] = await Promise.all([
        Transaction.aggregate(buildOperationsDayFacetPipeline(source, now)),
        loadActiveClientCompanyBalances(ClientCompany, source),
        ExecutorGroup.find(activeExecutorStripQuery(source))
            .select('name balance isApiBot isApiGroup lastApiServiceCredit serviceBalances serviceKey serviceKeys')
            .lean()
    ]);
    const facet = facetRows && facetRows[0] ? facetRows[0] : {};
    const totals = Array.isArray(facet.totals) && facet.totals[0] ? facet.totals[0] : {};
    const allocatedByGroup = await loadAllocatedBalances((executors || []).map((group) => group._id));
    const completedByCompany = indexAggregation(facet.completedByCompany, 'count');
    const depositsByCompany = indexAggregation(facet.depositsByCompany, 'total');
    return {
        today: {
            egyptianEGP: Number(totals.egyptianEGP) || 0,
            libyanLYD: Number(totals.libyanLYD) || 0
        },
        todayDepositsTotal: sumValues(facet.depositsByCompany, 'total'),
        activeExecutors: mapActiveExecutorStrip(executors, allocatedByGroup),
        companies: mapCompanyStrip(companies, completedByCompany, depositsByCompany)
    };
};

module.exports = {
    activeExecutorStripQuery,
    buildOperationsDayFacetPipeline,
    emptyOperationsSummary,
    loadOperationsSummaryStrip,
    mapActiveExecutorStrip,
    mapCompanyStrip
};
