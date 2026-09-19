'use strict';

const {
    emptyPeriodStats,
    fromFacetRow,
    loadCentralLedgerOverview,
    mapActiveClientCompanies,
    mapFundedExecutorBalances,
    successfulOpsLedgerMatch,
    successfulOpsPeriodBounds
} = require('../services/centralLedgerOverviewService');

describe('central ledger overview', () => {
    test('counts only completed operations and skips the counterpart of an internal balance transfer', () => {
        expect(successfulOpsLedgerMatch({}).status).toBe('completed');
        expect(successfulOpsLedgerMatch({})).toEqual(expect.objectContaining({
            $and: [{
                $or: [
                    { transferType: { $ne: 'balance_transfer' } },
                    { customId: { $not: /-C$/ } }
                ]
            }]
        }));
    });

    test('builds today, rolling 7-day week, and calendar-month bounds', () => {
        const bounds = successfulOpsPeriodBounds(new Date('2026-09-19T12:00:00+02:00'));
        expect(bounds.todayKey).toBe('2026-09-19');
        expect(bounds.weekStartKey).toBe('2026-09-13');
        expect(bounds.monthStartKey).toBe('2026-09-01');
        expect(bounds.today.$gte.toISOString()).toBe('2026-09-18T22:00:00.000Z');
        expect(bounds.week.$gte.toISOString()).toBe('2026-09-12T22:00:00.000Z');
        expect(bounds.month.$gte.toISOString()).toBe('2026-08-31T22:00:00.000Z');
    });

    test('maps empty or missing aggregation rows to zero counts', () => {
        expect(fromFacetRow(undefined)).toEqual({ count: 0, amountEGP: 0, costLYD: 0 });
        expect(fromFacetRow([])).toEqual({ count: 0, amountEGP: 0, costLYD: 0 });
        expect(fromFacetRow([{ count: 12, amountEGP: 5500, costLYD: 820 }])).toEqual({
            count: 12,
            amountEGP: 5500,
            costLYD: 820
        });
        expect(emptyPeriodStats().today.count).toBe(0);
    });

    test('keeps every active client company and its LYD balance', () => {
        expect(mapActiveClientCompanies([
            { _id: 'c1', name: 'شركة النور', balance: 125.5, accountCode: 'C-01', phone: '091000' },
            { _id: 'c2', name: 'شركة الرصيد الصفري', balance: 0 }
        ])).toEqual([
            { id: 'c1', name: 'شركة النور', balance: 125.5, accountCode: 'C-01', phone: '091000' },
            { id: 'c2', name: 'شركة الرصيد الصفري', balance: 0, accountCode: '', phone: '' }
        ]);
    });

    test('shows only executors with available balance above zero, preferring cached API service credit', () => {
        const mapped = mapFundedExecutorBalances([
            { _id: 'e1', name: 'منفذ كاش', balance: 400, isManagerBot: false },
            { _id: 'e2', name: 'منفذ بلا رصيد', balance: 0, isManagerBot: false },
            { _id: 'e3', name: 'API', balance: -10, isApiBot: true, lastApiServiceCredit: 90 },
            { _id: 'e4', name: 'API فارغ', balance: 0, isApiBot: true, lastApiServiceCredit: 0 },
            { _id: 'e5', name: 'وكالة', balance: 800, isManagerBot: true }
        ]);

        expect(mapped.map((row) => row.id)).toEqual(['e5', 'e1', 'e3']);
        expect(mapped.find((row) => row.id === 'e3')).toMatchObject({
            balance: 90,
            balanceSource: 'api_service'
        });
        expect(mapped.find((row) => row.id === 'e5').isManager).toBe(true);
    });

    test('loads period stats, companies and funded executors in parallel', async () => {
        const Transaction = {
            aggregate: jest.fn().mockResolvedValue([{
                today: [{ count: 3, amountEGP: 300, costLYD: 40 }],
                week: [{ count: 10, amountEGP: 1000, costLYD: 140 }],
                month: [{ count: 21, amountEGP: 2100, costLYD: 300 }]
            }])
        };
        const ClientCompany = {
            find: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([{ _id: 'c1', name: 'شركة أ', balance: 12 }])
            })
        };
        const ExecutorGroup = {
            find: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue([
                    { _id: 'e1', name: 'منفذ أ', balance: 50 },
                    { _id: 'e2', name: 'منفذ ب', balance: 0 }
                ])
            })
        };

        const overview = await loadCentralLedgerOverview({
            Transaction,
            ClientCompany,
            ExecutorGroup,
            source: {},
            now: new Date('2026-09-19T10:00:00+02:00')
        });

        expect(overview.periodStats.today.count).toBe(3);
        expect(overview.periodStats.week.count).toBe(10);
        expect(overview.periodStats.month.count).toBe(21);
        expect(overview.activeClientCompanies).toHaveLength(1);
        expect(overview.fundedExecutorCompanies.map((row) => row.id)).toEqual(['e1']);
        expect(Transaction.aggregate).toHaveBeenCalledTimes(1);
        expect(Transaction.aggregate.mock.calls[0][0][0].$match.status).toBe('completed');
        expect(ClientCompany.find).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
        expect(ExecutorGroup.find).toHaveBeenCalledWith(expect.objectContaining({
            status: 'active',
            $or: [
                { balance: { $gt: 0 } },
                { isApiBot: true, lastApiServiceCredit: { $gt: 0 } }
            ]
        }));
    });
});
