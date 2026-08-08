'use strict';

const SubAccount = require('../models/SubAccount');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const AgencyJournal = require('../models/AgencyJournal');
const {
    applyCustomerRateMargins,
    calculateAgencyPricing,
    pricingFromTransaction,
    resolveMarginPiasters,
    roundMoney
} = require('../utils/agencyPricing');
const { SERVICE_RATE_KEYS } = require('../utils/rateHelper');
const { calculateCreditState } = require('./agencyCreditLimitService');

const OPEN_STATUSES = Object.freeze(['pending', 'processing', 'accepted']);
const CANCELLED_STATUSES = Object.freeze(['rejected', 'cancelled_by_admin']);
const AGENCY_TRANSFER_STATUSES = Object.freeze([
    ...OPEN_STATUSES,
    'completed',
    ...CANCELLED_STATUSES
]);

const safeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const isAgencyTransfer = (transaction) =>
    Boolean(transaction?.isSubAccountTx && AGENCY_TRANSFER_STATUSES.includes(transaction.status));

const transactionProfit = (transaction) => {
    if (!isAgencyTransfer(transaction)) return 0;
    return Math.max(0, pricingFromTransaction(transaction).profitLYD);
};

const calculateAgencyMetrics = ({ walletBalance = 0, customers = [], transactions = [] } = {}) => {
    const customerTotals = customers.reduce((totals, customer) => {
        const creditState = calculateCreditState(customer);
        totals.positiveBalances += Math.max(0, creditState.balance);
        totals.debts += creditState.debt;
        totals.creditLimits += creditState.creditLimit;
        totals.activeCustomers += customer.status === 'active' ? 1 : 0;
        return totals;
    }, { positiveBalances: 0, debts: 0, creditLimits: 0, activeCustomers: 0 });

    const transactionTotals = transactions.reduce((totals, transaction) => {
        const pricing = pricingFromTransaction(transaction);
        if (OPEN_STATUSES.includes(transaction.status)) {
            totals.reservedAgency += pricing.agentCostLYD;
            totals.reservedCustomers += pricing.customerChargeLYD;
            totals.expectedProfit += pricing.profitLYD;
            totals.pendingCount += 1;
        } else if (transaction.status === 'completed') {
            totals.realizedProfit += pricing.profitLYD;
            totals.completedCount += 1;
        } else if (CANCELLED_STATUSES.includes(transaction.status)) {
            totals.reversedProfit += pricing.profitLYD;
            totals.cancelledCount += 1;
        }
        return totals;
    }, {
        reservedAgency: 0,
        reservedCustomers: 0,
        expectedProfit: 0,
        realizedProfit: 0,
        reversedProfit: 0,
        pendingCount: 0,
        completedCount: 0,
        cancelledCount: 0
    });

    const availableWallet = safeNumber(walletBalance);
    const metrics = {
        customerCount: customers.length,
        ...customerTotals,
        ...transactionTotals,
        availableWallet,
        bookWallet: availableWallet + transactionTotals.reservedAgency,
        customerNet: customerTotals.positiveBalances - customerTotals.debts,
        coveragePosition: availableWallet - customerTotals.positiveBalances + customerTotals.debts
    };

    return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
        key,
        typeof value === 'number' ? roundMoney(value) : value
    ]));
};

const buildProfitRows = (transactions, customersById) => {
    const groups = new Map();
    transactions.filter(isAgencyTransfer).forEach((transaction) => {
        const customerId = String(transaction.subAccountId || 'unknown');
        const current = groups.get(customerId) || {
            customerId,
            customerName: customersById.get(customerId)?.name || transaction.subAccountName || 'عميل تابع',
            operationCount: 0,
            completedCount: 0,
            totalEGP: 0,
            realizedProfit: 0,
            expectedProfit: 0,
            reversedProfit: 0,
            lastActivity: transaction.createdAt
        };
        const pricing = pricingFromTransaction(transaction);
        current.operationCount += 1;
        if (transaction.status === 'completed') {
            current.completedCount += 1;
            current.totalEGP += safeNumber(transaction.amount);
            current.realizedProfit += pricing.profitLYD;
        } else if (OPEN_STATUSES.includes(transaction.status)) {
            current.expectedProfit += pricing.profitLYD;
        } else if (CANCELLED_STATUSES.includes(transaction.status)) {
            current.reversedProfit += pricing.profitLYD;
        }
        if (new Date(transaction.createdAt) > new Date(current.lastActivity)) current.lastActivity = transaction.createdAt;
        groups.set(customerId, current);
    });

    return [...groups.values()]
        .map((row) => ({
            ...row,
            totalEGP: roundMoney(row.totalEGP, 2),
            realizedProfit: roundMoney(row.realizedProfit),
            expectedProfit: roundMoney(row.expectedProfit),
            reversedProfit: roundMoney(row.reversedProfit)
        }))
        .sort((left, right) => right.realizedProfit - left.realizedProfit);
};

const buildServiceProfitRows = (transactions) => SERVICE_RATE_KEYS.map((serviceKey) => {
    const rows = transactions.filter((transaction) => isAgencyTransfer(transaction) && transaction.transferType === serviceKey);
    return {
        serviceKey,
        operationCount: rows.length,
        totalEGP: roundMoney(rows.filter((row) => row.status === 'completed').reduce((sum, row) => sum + safeNumber(row.amount), 0), 2),
        realizedProfit: roundMoney(rows.filter((row) => row.status === 'completed').reduce((sum, row) => sum + transactionProfit(row), 0)),
        expectedProfit: roundMoney(rows.filter((row) => OPEN_STATUSES.includes(row.status)).reduce((sum, row) => sum + transactionProfit(row), 0))
    };
}).filter((row) => row.operationCount > 0);

const enrichCustomers = (customers, openTransactions, periodTransactions) => {
    const openByCustomer = new Map();
    const periodByCustomer = new Map();
    openTransactions.forEach((transaction) => {
        const key = String(transaction.subAccountId);
        const pricing = pricingFromTransaction(transaction);
        const current = openByCustomer.get(key) || { reserved: 0, expectedProfit: 0, count: 0 };
        current.reserved += pricing.customerChargeLYD;
        current.expectedProfit += pricing.profitLYD;
        current.count += 1;
        openByCustomer.set(key, current);
    });
    periodTransactions.forEach((transaction) => {
        const key = String(transaction.subAccountId);
        const current = periodByCustomer.get(key) || { completedCount: 0, totalEGP: 0, realizedProfit: 0 };
        if (transaction.status === 'completed') {
            current.completedCount += 1;
            current.totalEGP += safeNumber(transaction.amount);
            current.realizedProfit += transactionProfit(transaction);
        }
        periodByCustomer.set(key, current);
    });

    return customers.map((customer) => {
        const creditState = calculateCreditState(customer);
        const open = openByCustomer.get(String(customer._id)) || { reserved: 0, expectedProfit: 0, count: 0 };
        const period = periodByCustomer.get(String(customer._id)) || { completedCount: 0, totalEGP: 0, realizedProfit: 0 };
        return {
            ...customer,
            ...creditState,
            positiveBalance: Math.max(0, creditState.balance),
            reserved: roundMoney(open.reserved),
            expectedProfit: roundMoney(open.expectedProfit),
            openOperationCount: open.count,
            completedCount: period.completedCount,
            totalEGP: roundMoney(period.totalEGP, 2),
            realizedProfit: roundMoney(period.realizedProfit),
            marginPiasters: resolveMarginPiasters(customer, 'vodafone')
        };
    });
};

const loadAgencyFinance = async (workspace, { range } = {}) => {
    if (!workspace?.isAgent) return null;
    const customerFilter = { masterType: 'user', masterId: workspace.entity._id, status: { $ne: 'deleted' } };
    const customers = await SubAccount.find(customerFilter).sort({ name: 1 }).lean();
    const customerIds = customers.map((customer) => customer._id);
    const transactionBase = { isSubAccountTx: true, subAccountId: { $in: customerIds } };
    const dateFilter = range ? { createdAt: { $gte: range.start, $lte: range.end } } : {};

    const [periodTransactions, openTransactions, agencyLedger, journals, settlements] = await Promise.all([
        Transaction.find({ ...transactionBase, ...dateFilter }).sort({ createdAt: -1 }).limit(5000).lean(),
        Transaction.find({ ...transactionBase, status: { $in: OPEN_STATUSES } }).sort({ createdAt: -1 }).lean(),
        Ledger.find({ entityId: workspace.entity._id, entityModel: 'User', ...dateFilter }).sort({ createdAt: -1 }).limit(300).lean(),
        AgencyJournal.find({ ownerType: 'agent', ownerId: workspace.entity._id, ...dateFilter }).sort({ createdAt: -1 }).limit(300).lean(),
        Transaction.find({ ...transactionBase, ...dateFilter, status: { $in: ['deposit', 'deduction'] } }).sort({ createdAt: -1 }).limit(300).lean()
    ]);

    const customerRows = enrichCustomers(customers, openTransactions, periodTransactions);
    const allMetricTransactions = [...periodTransactions.filter((transaction) => !OPEN_STATUSES.includes(transaction.status)), ...openTransactions];
    const metrics = calculateAgencyMetrics({
        walletBalance: workspace.entity.balance,
        customers,
        transactions: allMetricTransactions
    });
    const customersById = new Map(customers.map((customer) => [String(customer._id), customer]));
    const settlementSummary = settlements.reduce((totals, transaction) => {
        if (transaction.status === 'deposit') totals.received += safeNumber(transaction.amount);
        if (transaction.status === 'deduction') totals.paid += safeNumber(transaction.amount);
        return totals;
    }, { received: 0, paid: 0 });

    return {
        metrics,
        customerRows,
        positiveCustomers: customerRows.filter((customer) => customer.positiveBalance > 0),
        debtCustomers: customerRows.filter((customer) => customer.debt > 0),
        profitRows: buildProfitRows(periodTransactions, customersById),
        serviceProfitRows: buildServiceProfitRows(periodTransactions),
        periodTransactions,
        openTransactions,
        agencyLedger,
        journals,
        settlements,
        settlementSummary: {
            received: roundMoney(settlementSummary.received),
            paid: roundMoney(settlementSummary.paid),
            net: roundMoney(settlementSummary.received - settlementSummary.paid)
        }
    };
};

const loadCustomerProfile = async (workspace, customerId, { range, masterRates } = {}) => {
    if (!workspace?.isAgent) return null;
    const customer = await SubAccount.findOne({
        _id: customerId,
        masterType: 'user',
        masterId: workspace.entity._id,
        status: { $ne: 'deleted' }
    }).lean();
    if (!customer) return null;

    const dateFilter = range ? { createdAt: { $gte: range.start, $lte: range.end } } : {};
    const [transactions, openTransactions, ledgerRows, journals] = await Promise.all([
        Transaction.find({ subAccountId: customer._id, ...dateFilter }).sort({ createdAt: -1 }).limit(500).lean(),
        Transaction.find({ subAccountId: customer._id, status: { $in: OPEN_STATUSES } }).sort({ createdAt: -1 }).lean(),
        Ledger.find({ entityId: customer._id, entityModel: 'SubAccount', ...dateFilter }).sort({ createdAt: -1 }).limit(300).lean(),
        AgencyJournal.find({ ownerId: workspace.entity._id, customerId: customer._id, ...dateFilter }).sort({ createdAt: -1 }).limit(300).lean()
    ]);
    const effectiveRates = applyCustomerRateMargins(masterRates || {}, customer);
    const pricingRows = SERVICE_RATE_KEYS.map((serviceKey) => ({
        serviceKey,
        marginPiasters: resolveMarginPiasters(customer, serviceKey),
        agentRate: safeNumber(masterRates?.[serviceKey]),
        customerRate: safeNumber(effectiveRates[serviceKey]),
        example: calculateAgencyPricing({ amountEGP: 1000, masterRates, serviceKey, subAccount: customer })
    }));
    const enriched = enrichCustomers([customer], openTransactions, transactions)[0];
    const metrics = calculateAgencyMetrics({ walletBalance: 0, customers: [customer], transactions: [...transactions.filter((row) => !OPEN_STATUSES.includes(row.status)), ...openTransactions] });

    return {
        customer: enriched,
        transactions,
        ledgerRows,
        journals,
        pricingRows,
        metrics,
        profitRows: buildProfitRows(transactions, new Map([[String(customer._id), customer]]))
    };
};

module.exports = {
    OPEN_STATUSES,
    CANCELLED_STATUSES,
    AGENCY_TRANSFER_STATUSES,
    isAgencyTransfer,
    transactionProfit,
    calculateAgencyMetrics,
    buildProfitRows,
    buildServiceProfitRows,
    loadAgencyFinance,
    loadCustomerProfile
};
