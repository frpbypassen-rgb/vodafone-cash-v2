'use strict';

const { getExecutorPrimaryServiceKey, getExecutorEnabledServiceKeys, getExecutorServiceLabel } = require('../utils/executorServiceCatalog');
const { allocatedFromRows, ledgerServiceKeyForTransaction, snapshotServiceLedgers } = require('../utils/executorServiceLedger');

// Aggregate compact ledger buckets, not entire transaction documents. Keep the
// same classification and sign rules as reconcileBotBalance, without any writes.
const ledgerPipeline = (field, ids) => [
    { $match: { [field]: { $in: ids }, status: { $in: ['completed', 'deposit', 'deduction'] } } },
    { $group: {
        _id: { groupId: `$${field}`, status: '$status', canonicalServiceKey: '$canonicalServiceKey', transferType: '$transferType' },
        count: { $sum: 1 },
        amount: { $sum: { $cond: [{ $eq: ['$status', 'deduction'] }, { $abs: { $ifNull: ['$amount', 0] } }, { $ifNull: ['$amount', 0] }] } }
    } }
];

const indexRows = (rows, field) => {
    const map = new Map();
    rows.forEach(row => {
        const key = String(field(row));
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    });
    return map;
};

async function loadExecutorDirectory({ groups, archivedGroups, Transaction, Employee, ExecutorBalancePool }) {
    const ids = groups.map(group => group._id);
    const managerIds = groups.filter(group => group.isManagerGroup || group.isManagerBot).map(group => group._id);
    const archiveIds = archivedGroups.filter(group => group.archiveTransactionCount == null).map(group => group._id);
    const active = { $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }] };
    const [executorRows, managerRows, pools, employees, archivedCounts] = await Promise.all([
        ids.length ? Transaction.aggregate(ledgerPipeline('executorGroupId', ids)) : [],
        managerIds.length ? Transaction.aggregate(ledgerPipeline('managerGroupId', managerIds)) : [],
        ids.length ? ExecutorBalancePool.find({ groupId: { $in: ids }, ...active }).select('_id groupId balance').lean() : [],
        ids.length ? Employee.find({ groupId: { $in: ids }, role: 'external', ...active }).select('groupId role balance balancePoolId').lean() : [],
        archiveIds.length ? Transaction.aggregate([
            { $match: { $or: [{ executorGroupId: { $in: archiveIds } }, { managerGroupId: { $in: archiveIds } }] } },
            { $project: { ids: { $setIntersection: [{ $setUnion: [['$executorGroupId', '$managerGroupId'], []] }, archiveIds] } } },
            { $unwind: '$ids' },
            { $group: { _id: '$ids', count: { $sum: 1 } } }
        ]) : []
    ]);
    const byExecutor = indexRows(executorRows, row => row._id.groupId);
    const byManager = indexRows(managerRows, row => row._id.groupId);
    const byPool = indexRows(pools, row => row.groupId);
    const byEmployee = indexRows(employees, row => row.groupId);
    const archiveCounts = new Map(archivedCounts.map(row => [String(row._id), row.count]));

    const bots = groups.map(group => {
        const id = String(group._id);
        const primary = getExecutorPrimaryServiceKey(group);
        const own = byExecutor.get(id) || [];
        const managed = byManager.get(id) || [];
        const rows = group.isManagerGroup
            ? [...own.filter(row => row._id.status !== 'completed'), ...managed.filter(row => row._id.status === 'completed')]
            : own;
        const balances = {};
        rows.forEach(row => {
            const key = ledgerServiceKeyForTransaction(row._id, primary);
            if (!key) return;
            balances[key] = (balances[key] || 0) + (row._id.status === 'deposit' ? row.amount : -row.amount);
        });
        const allocated = allocatedFromRows({ pools: byPool.get(id) || [], employees: byEmployee.get(id) || [] });
        balances[primary] = (balances[primary] || 0) - allocated;
        const ledgerGroup = { ...group, balance: balances[primary], serviceBalances: balances };
        const ledgers = snapshotServiceLedgers({ group: ledgerGroup, allocatedBalance: allocated });
        const txCount = (group.isManagerBot ? managed : own)
            .filter(row => row._id.status === 'completed').reduce((sum, row) => sum + row.count, 0);
        return {
            ...group, balance: balances[primary], txCount,
            serviceKey: primary, serviceKeys: getExecutorEnabledServiceKeys(group),
            serviceLabel: getExecutorServiceLabel(group), serviceBalances: ledgers.byService, multiService: ledgers.multiService,
            // A saved provider snapshot is explicitly labelled with its timestamp.
            // Opening the directory must never wait for, or initiate, provider calls.
            liveApiServiceCredit: group.lastApiServiceCredit ?? null,
            liveApiBalanceCheckedAt: [group.lastApiBalanceCheckAt, group.lastApiTestAt, group.lastApiTransferTestAt]
                .filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null,
            liveApiBalanceError: group.lastApiBalanceCheckStatus === 'check_failed' ? 'تعذر آخر فحص لرصيد المزود' : ''
        };
    });
    return {
        bots,
        archivedBots: archivedGroups.map(group => ({
            ...group, balance: group.archiveBalance ?? group.balance,
            txCount: group.archiveTransactionCount ?? archiveCounts.get(String(group._id)) ?? 0,
            serviceKey: getExecutorPrimaryServiceKey(group), serviceLabel: getExecutorServiceLabel(group)
        }))
    };
}

module.exports = { loadExecutorDirectory, ledgerPipeline };
