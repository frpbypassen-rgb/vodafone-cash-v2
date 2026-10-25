'use strict';

const Transaction = require('../../models/Transaction');
const Ledger = require('../../models/Ledger');
const { sanitizeStatementMovement } = require('../../utils/accountStatementPrivacy');
const { safeNumber, resolveDateRange } = require('./primitives');
const { ownershipFilter } = require('./transactions');
const { countPendingCompanyDeposits } = require('./deposits');

const movementFromTransaction = (tx) => {
    if (tx.status === 'deposit') {
        return {
            transactionId: tx.customId,
            type: 'DEPOSIT',
            amount: safeNumber(tx.amount),
            direction: 'credit',
            description: 'إيداع رصيد',
            createdAt: tx.createdAt,
            source: 'transaction',
        };
    }
    if (tx.status === 'deduction') {
        return {
            transactionId: tx.customId,
            type: 'DEDUCTION',
            amount: -Math.abs(safeNumber(tx.amount)),
            direction: 'debit',
            description: 'خصم رصيد',
            createdAt: tx.createdAt,
            source: 'transaction',
        };
    }
    if (tx.status === 'completed') {
        return {
            transactionId: tx.customId,
            type: 'TRANSFER',
            amount: -Math.abs(safeNumber(tx.costLYD)),
            direction: 'debit',
            description: `تحويل ${safeNumber(tx.amount).toLocaleString('en-US')} EGP`,
            createdAt: tx.createdAt,
            source: 'transaction',
        };
    }
    if (tx.status === 'cancelled_by_admin') {
        return {
            transactionId: tx.customId,
            type: 'REFUND',
            amount: Math.abs(safeNumber(tx.costLYD)),
            direction: 'credit',
            description: 'إرجاع عملية ملغية',
            createdAt: tx.cancelledAt || tx.updatedAt || tx.createdAt,
            source: 'transaction',
        };
    }
    return null;
};

const loadFinance = async (workspace, query = {}) => {
    const range = resolveDateRange(query, { forceToday: workspace.forceToday });
    const ownership = await ownershipFilter(workspace);
    const transactionConditions = {
        $and: [
            ownership,
            { createdAt: { $gte: range.start, $lte: range.end } },
            { status: { $in: ['completed', 'deposit', 'deduction', 'cancelled_by_admin'] } },
        ],
    };
    const ledgerMatch = {
        entityId: workspace.entity._id,
        entityModel: workspace.entityModel,
        createdAt: { $gte: range.start, $lte: range.end },
    };
    const displayLimit = 300;
    const [ledgerRowsResult, transactionsResult, ledgerSummaryRows, fallbackSummaryRows] = await Promise.all([
        Ledger.find({
            ...ledgerMatch,
        })
            .sort({ createdAt: -1 })
            .limit(displayLimit + 1)
            .lean(),
        Transaction.find(transactionConditions)
            .sort({ createdAt: -1 })
            .limit(displayLimit + 1)
            .lean(),
        Ledger.aggregate([
            { $match: ledgerMatch },
            {
                $group: {
                    _id: null,
                    credits: { $sum: { $cond: [{ $gte: ['$amount', 0] }, '$amount', 0] } },
                    debits: { $sum: { $cond: [{ $lt: ['$amount', 0] }, { $abs: '$amount' }, 0] } },
                    net: { $sum: '$amount' },
                    count: { $sum: 1 },
                },
            },
        ]),
        Transaction.aggregate([
            { $match: transactionConditions },
            {
                $lookup: {
                    from: Ledger.collection.name,
                    let: { customId: '$customId' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$transactionId', '$$customId'] },
                                        { $eq: ['$entityId', workspace.entity._id] },
                                        { $eq: ['$entityModel', workspace.entityModel] },
                                    ],
                                },
                            },
                        },
                        { $limit: 1 },
                    ],
                    as: 'ledgerMatch',
                },
            },
            { $match: { 'ledgerMatch.0': { $exists: false } } },
            {
                $project: {
                    movementAmount: {
                        $switch: {
                            branches: [
                                { case: { $eq: ['$status', 'deposit'] }, then: '$amount' },
                                {
                                    case: { $eq: ['$status', 'deduction'] },
                                    then: { $multiply: ['$amount', -1] },
                                },
                                {
                                    case: { $eq: ['$status', 'completed'] },
                                    then: { $multiply: ['$costLYD', -1] },
                                },
                                { case: { $eq: ['$status', 'cancelled_by_admin'] }, then: '$costLYD' },
                            ],
                            default: 0,
                        },
                    },
                },
            },
            {
                $group: {
                    _id: null,
                    credits: { $sum: { $cond: [{ $gte: ['$movementAmount', 0] }, '$movementAmount', 0] } },
                    debits: {
                        $sum: { $cond: [{ $lt: ['$movementAmount', 0] }, { $abs: '$movementAmount' }, 0] },
                    },
                    net: { $sum: '$movementAmount' },
                    count: { $sum: 1 },
                },
            },
        ]),
    ]);
    const listTruncated = ledgerRowsResult.length > displayLimit || transactionsResult.length > displayLimit;
    const ledgerRows = ledgerRowsResult.slice(0, displayLimit);
    const transactions = transactionsResult.slice(0, displayLimit);
    const ledgerIds = new Set(ledgerRows.map((row) => row.transactionId));
    const fallbackRows = transactions
        .filter((tx) => !ledgerIds.has(tx.customId))
        .map(movementFromTransaction)
        .filter(Boolean);
    const movements = [
        ...ledgerRows
            .map((row) =>
                sanitizeStatementMovement({
                    ...row,
                    direction: safeNumber(row.amount) >= 0 ? 'credit' : 'debit',
                    source: 'ledger',
                })
            )
            .filter(Boolean),
        ...fallbackRows,
    ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    // الإجماليات لا تعتمد على قائمة العرض المحدودة. بذلك يبقى كشف الحساب
    // صحيحاً حتى عندما تحتوي الفترة على آلاف الحركات.
    const ledgerSummary = ledgerSummaryRows[0] || {};
    const fallbackSummary = fallbackSummaryRows[0] || {};
    const financeSummary = ['credits', 'debits', 'net', 'count'].reduce((summary, key) => {
        summary[key] = safeNumber(ledgerSummary[key]) + safeNumber(fallbackSummary[key]);
        return summary;
    }, {});
    const pendingDepositCount = workspace.isCompany
        ? await countPendingCompanyDeposits(workspace, ownership)
        : 0;

    return {
        movements,
        financeSummary,
        listTruncated,
        shownMovementCount: movements.length,
        pendingDepositCount,
        filters: { ...range, type: query.type || '' },
    };
};

module.exports = { movementFromTransaction, loadFinance };
