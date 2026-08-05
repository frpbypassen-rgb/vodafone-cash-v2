'use strict';

const CANCELLED_STATUSES = new Set(['rejected', 'cancelled_by_admin']);
const BALANCE_STATUSES = new Set(['deposit', 'deduction', 'deposit_pending']);

const numberValue = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const absoluteAmount = (transaction) => Math.abs(numberValue(transaction?.amount));

const newestFirst = (left, right) => (
    new Date(right?.createdAt || 0).getTime() - new Date(left?.createdAt || 0).getTime()
);

const calculateBalanceDelta = (transaction, isExecutor = false) => {
    if (!transaction || CANCELLED_STATUSES.has(transaction.status)) return 0;
    if (transaction.status === 'deposit') return absoluteAmount(transaction);
    if (transaction.status === 'deduction') return -absoluteAmount(transaction);
    if (transaction.status === 'completed') {
        return -(isExecutor ? absoluteAmount(transaction) : numberValue(transaction.costLYD));
    }
    return 0;
};

const calculateOpeningBalance = (transactions = [], isExecutor = false) => (
    transactions.reduce((total, transaction) => total + calculateBalanceDelta(transaction, isExecutor), 0)
);

const splitReportTransactions = (transactions = []) => {
    const completedOperations = [];
    const pendingOperations = [];
    const cancelledOperations = [];
    const deposits = [];
    const deductions = [];
    const pendingDeposits = [];

    transactions.forEach((transaction) => {
        if (!transaction) return;
        if (CANCELLED_STATUSES.has(transaction.status)) {
            cancelledOperations.push(transaction);
            return;
        }
        if (transaction.status === 'deposit') {
            deposits.push(transaction);
            return;
        }
        if (transaction.status === 'deduction') {
            deductions.push(transaction);
            return;
        }
        if (transaction.status === 'deposit_pending') {
            pendingDeposits.push(transaction);
            return;
        }
        if (transaction.status === 'completed') {
            completedOperations.push(transaction);
            return;
        }
        pendingOperations.push(transaction);
    });

    [completedOperations, pendingOperations, cancelledOperations, deposits, deductions, pendingDeposits]
        .forEach((items) => items.sort(newestFirst));

    return {
        completedOperations,
        pendingOperations,
        cancelledOperations,
        deposits,
        deductions,
        pendingDeposits
    };
};

const buildReportSummary = ({
    previousTransactions = [],
    currentTransactions = [],
    isExecutor = false
} = {}) => {
    const groups = splitReportTransactions(currentTransactions);
    const previousBalance = calculateOpeningBalance(previousTransactions, isExecutor);

    const totalEGP = groups.completedOperations.reduce(
        (total, transaction) => total + absoluteAmount(transaction),
        0
    );
    const totalLYD = groups.completedOperations.reduce(
        (total, transaction) => total + numberValue(transaction.costLYD),
        0
    );
    const totalDeposits = groups.deposits.reduce(
        (total, transaction) => total + absoluteAmount(transaction),
        0
    );
    const totalDeductions = groups.deductions.reduce(
        (total, transaction) => total + absoluteAmount(transaction),
        0
    );
    const operationsCost = isExecutor ? totalEGP : totalLYD;
    const netAdjustments = totalDeposits - totalDeductions;
    const dailyNet = netAdjustments - operationsCost;
    const endingBalance = previousBalance + dailyNet;
    const cancelledEGP = groups.cancelledOperations.reduce(
        (total, transaction) => total + absoluteAmount(transaction),
        0
    );
    const cancelledLYD = groups.cancelledOperations.reduce(
        (total, transaction) => total + numberValue(transaction.costLYD),
        0
    );

    return {
        ...groups,
        operations: [...groups.completedOperations, ...groups.pendingOperations],
        depositsAndDeductions: [...groups.deposits, ...groups.deductions, ...groups.pendingDeposits]
            .sort(newestFirst),
        stats: {
            previousBalance,
            endingBalance,
            totalLYD,
            totalEGP,
            totalDeposits,
            totalDeductions,
            netAdjustments,
            dailyNet,
            operationsCost,
            completedCount: groups.completedOperations.length,
            pendingCount: groups.pendingOperations.length + groups.pendingDeposits.length,
            rejectedCount: groups.cancelledOperations.length,
            cancelledCount: groups.cancelledOperations.length,
            totalCount: groups.completedOperations.length
                + groups.pendingOperations.length
                + groups.cancelledOperations.length,
            cancelledEGP,
            cancelledLYD,
            accountingCurrency: isExecutor ? 'EGP' : 'LYD',
            isExecutor
        }
    };
};

module.exports = {
    BALANCE_STATUSES,
    CANCELLED_STATUSES,
    buildReportSummary,
    calculateBalanceDelta,
    calculateOpeningBalance,
    splitReportTransactions
};
