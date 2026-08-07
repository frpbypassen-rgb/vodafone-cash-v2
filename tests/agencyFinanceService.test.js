'use strict';

const {
    calculateAgencyMetrics,
    buildProfitRows,
    transactionProfit
} = require('../services/agencyFinanceService');

const customer = (id, balance, creditLimit = 0) => ({
    _id: id,
    name: `Customer ${id}`,
    balance,
    creditLimit,
    status: 'active'
});

const transfer = ({ id, customerId, status, agentCost, customerCharge, profit }) => ({
    customId: id,
    subAccountId: customerId,
    subAccountName: `Customer ${customerId}`,
    isSubAccountTx: true,
    transferType: 'vodafone',
    amount: 1000,
    status,
    createdAt: new Date('2026-08-07T10:00:00Z'),
    agencyPricing: {
        agentCostLYD: agentCost,
        customerChargeLYD: customerCharge,
        profitLYD: profit,
        agentRate: 5.98,
        customerRate: 5.95,
        marginPiasters: 3
    }
});

describe('agency financial position', () => {
    test('separates customer balances, debt and coverage position', () => {
        const metrics = calculateAgencyMetrics({
            walletBalance: 900,
            customers: [customer('a', 400), customer('b', -50, 100)],
            transactions: []
        });

        expect(metrics.positiveBalances).toBe(400);
        expect(metrics.debts).toBe(50);
        expect(metrics.customerNet).toBe(350);
        expect(metrics.coveragePosition).toBe(550);
        expect(metrics.creditLimits).toBe(100);
    });

    test('keeps pending profit expected and restores the pre-reservation book wallet', () => {
        const pending = transfer({ id: 'P-1', customerId: 'a', status: 'pending', agentCost: 167.224, customerCharge: 168.067, profit: 0.843 });
        const metrics = calculateAgencyMetrics({
            walletBalance: 832.776,
            customers: [customer('a', 331.933)],
            transactions: [pending]
        });

        expect(metrics.reservedAgency).toBe(167.224);
        expect(metrics.reservedCustomers).toBe(168.067);
        expect(metrics.bookWallet).toBe(1000);
        expect(metrics.expectedProfit).toBe(0.843);
        expect(metrics.realizedProfit).toBe(0);
    });

    test('realizes completed profit and excludes cancelled profit from the total', () => {
        const completed = transfer({ id: 'C-1', customerId: 'a', status: 'completed', agentCost: 167.224, customerCharge: 168.067, profit: 0.843 });
        const cancelled = transfer({ id: 'X-1', customerId: 'a', status: 'cancelled_by_admin', agentCost: 100, customerCharge: 102, profit: 2 });
        const metrics = calculateAgencyMetrics({ walletBalance: 800, customers: [customer('a', 300)], transactions: [completed, cancelled] });

        expect(metrics.realizedProfit).toBe(0.843);
        expect(metrics.reversedProfit).toBe(2);
        expect(metrics.expectedProfit).toBe(0);
        expect(transactionProfit(cancelled)).toBe(2);
    });

    test('groups profit by customer and lifecycle', () => {
        const rows = buildProfitRows([
            transfer({ id: 'C-1', customerId: 'a', status: 'completed', agentCost: 100, customerCharge: 102, profit: 2 }),
            transfer({ id: 'P-1', customerId: 'a', status: 'processing', agentCost: 50, customerCharge: 51, profit: 1 }),
            transfer({ id: 'X-1', customerId: 'b', status: 'rejected', agentCost: 20, customerCharge: 20.5, profit: 0.5 })
        ], new Map([['a', { name: 'أحمد' }], ['b', { name: 'سالم' }]]));

        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.customerId === 'a')).toMatchObject({
            customerName: 'أحمد',
            realizedProfit: 2,
            expectedProfit: 1,
            reversedProfit: 0
        });
        expect(rows.find((row) => row.customerId === 'b').reversedProfit).toBe(0.5);
    });

    test('excludes customer settlements from transfer profit and operation counts', () => {
        const settlement = {
            ...transfer({ id: 'SET-1', customerId: 'a', status: 'completed', agentCost: 0, customerCharge: 50, profit: 50 }),
            status: 'deposit',
            settlementDetails: { category: 'customer_payment' }
        };

        expect(transactionProfit(settlement)).toBe(0);
        expect(buildProfitRows([settlement], new Map([['a', { name: 'أحمد' }]]))).toEqual([]);
    });
});
