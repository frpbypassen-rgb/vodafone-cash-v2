'use strict';

const {
    buildReportSummary,
    calculateBalanceDelta,
    splitReportTransactions
} = require('../utils/adminReportCalculations');
const { buildPostCloseChanges, getDateRange } = require('../services/adminReportService');

describe('Admin financial report calculations', () => {
    test('separates deposits and deductions and excludes every cancelled movement from totals', () => {
        const previousTransactions = [
            { status: 'completed', amount: 4000, costLYD: 640 },
            { status: 'deposit', amount: 1000 },
            { status: 'deduction', amount: 100 },
            { status: 'cancelled_by_admin', amount: 9999, costLYD: 1550 }
        ];
        const currentTransactions = [
            { customId: 'OK-1', status: 'completed', amount: 1600, costLYD: 250 },
            { customId: 'WAIT-1', status: 'processing', amount: 2000, costLYD: 310 },
            { customId: 'REJ-1', status: 'rejected', amount: 5000, costLYD: 780 },
            { customId: 'VOID-DEP', status: 'cancelled_by_admin', amount: 700, balanceAdjustment: { originalStatus: 'deposit' } },
            { customId: 'DEP-1', status: 'deposit', amount: 500 },
            { customId: 'DED-1', status: 'deduction', amount: 120 },
            { customId: 'DEP-WAIT', status: 'deposit_pending', amount: 300 }
        ];

        const report = buildReportSummary({ previousTransactions, currentTransactions, isExecutor: false });

        expect(report.stats.previousBalance).toBe(260);
        expect(report.stats.totalEGP).toBe(1600);
        expect(report.stats.totalLYD).toBe(250);
        expect(report.stats.totalDeposits).toBe(500);
        expect(report.stats.totalDeductions).toBe(120);
        expect(report.stats.dailyNet).toBe(130);
        expect(report.stats.endingBalance).toBe(390);
        expect(report.stats.cancelledCount).toBe(2);
        expect(report.stats.pendingCount).toBe(2);
        expect(report.deposits.map((item) => item.customId)).toEqual(['DEP-1']);
        expect(report.deductions.map((item) => item.customId)).toEqual(['DED-1']);
        expect(report.cancelledOperations.map((item) => item.customId)).toEqual(expect.arrayContaining(['REJ-1', 'VOID-DEP']));
    });

    test('uses EGP as the accounting currency for executor balances', () => {
        const report = buildReportSummary({
            previousTransactions: [{ status: 'completed', amount: 2000, costLYD: 310 }],
            currentTransactions: [
                { status: 'completed', amount: 1000, costLYD: 155 },
                { status: 'deposit', amount: 500 },
                { status: 'deduction', amount: 100 }
            ],
            isExecutor: true
        });

        expect(report.stats.accountingCurrency).toBe('EGP');
        expect(report.stats.previousBalance).toBe(-2000);
        expect(report.stats.operationsCost).toBe(1000);
        expect(report.stats.dailyNet).toBe(-600);
        expect(report.stats.endingBalance).toBe(-2600);
    });

    test('never applies a cancelled transaction to a balance delta', () => {
        expect(calculateBalanceDelta({ status: 'cancelled_by_admin', amount: 900, costLYD: 140 })).toBe(0);
        expect(calculateBalanceDelta({ status: 'rejected', amount: 900, costLYD: 140 })).toBe(0);
    });

    test('keeps pending deposits outside both deposit and deduction lists', () => {
        const groups = splitReportTransactions([{ status: 'deposit_pending', amount: 100 }]);
        expect(groups.deposits).toHaveLength(0);
        expect(groups.deductions).toHaveLength(0);
        expect(groups.pendingDeposits).toHaveLength(1);
    });

    test('validates day and month report ranges', () => {
        const day = getDateRange('day', '2026-08-05');
        expect(day.start.getHours()).toBe(0);
        expect(day.end.getHours()).toBe(23);
        expect(day.start.toISOString()).toBe('2026-08-04T22:00:00.000Z');
        expect(day.end.toISOString()).toBe('2026-08-05T21:59:59.999Z');
        expect(() => getDateRange('day', '2026-02-30')).toThrow('INVALID_REPORT_DATE');
        expect(() => getDateRange('month', '2026-13')).toThrow('INVALID_REPORT_DATE');
    });

    test('reports an audited change only when it occurred after financial close', () => {
        const transaction = {
            _id: 'tx-1',
            customId: 'TX-001',
            companyId: 'company-1',
            status: 'completed',
            createdAt: new Date('2026-08-01T12:00:00'),
            updatedAt: new Date('2026-08-02T09:00:00')
        };
        const settlement = {
            period: { start: new Date('2026-08-01T00:00:00') },
            closedAt: new Date('2026-08-01T23:00:00')
        };
        const auditLogs = [{
            action: 'TRANSACTION_DATA_EDITED',
            targetId: 'tx-1',
            performedByName: 'مدير الاختبار',
            createdAt: new Date('2026-08-02T09:00:00'),
            oldData: { amount: 1000, createdAt: transaction.createdAt },
            newData: { amount: 1200, createdAt: transaction.createdAt },
            metadata: { transactionId: 'TX-001', companyId: 'company-1' }
        }];

        const changes = buildPostCloseChanges({
            transactions: [transaction],
            settlements: [settlement],
            auditLogs,
            auditScope: { mainCategory: 'company', subId: 'company-1', subType: 'all' },
            start: new Date('2026-08-01T00:00:00'),
            end: new Date('2026-08-01T23:59:59.999')
        });

        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ transactionId: 'TX-001', actor: 'مدير الاختبار', action: 'تعديل بيانات الحركة' });
        expect(changes[0].details).toContain('المبلغ');
    });
});
