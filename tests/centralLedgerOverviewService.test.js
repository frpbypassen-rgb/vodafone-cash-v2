'use strict';

const {
    adminVisibleCompanyQuery,
    adminVisibleExecutorQuery,
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
            isSubAccountTx: { $ne: true },
            $and: [{
                $or: [
                    { transferType: { $ne: 'balance_transfer' } },
                    { customId: { $not: /-C$/ } }
                ]
            }]
        }));
        expect(successfulOpsLedgerMatch({}).tenantId).toBeUndefined();
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
            { _id: 'e5', name: 'وكالة', balance: 800, isManagerBot: true },
            { _id: 'e6', name: 'API مجموعة', balance: 0, isApiGroup: true, lastApiServiceCredit: 70 }
        ]);

        expect(mapped.map((row) => row.id)).toEqual(['e5', 'e1', 'e3', 'e6']);
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
        expect(Transaction.aggregate.mock.calls[0][0][0].$match).toEqual(expect.objectContaining({
            status: 'completed',
            isSubAccountTx: { $ne: true }
        }));
        expect(Transaction.aggregate.mock.calls[0][0][0].$match.tenantId).toBeUndefined();
        expect(ClientCompany.find).toHaveBeenCalledWith(adminVisibleCompanyQuery({}));
        expect(ExecutorGroup.find).toHaveBeenCalledWith(adminVisibleExecutorQuery({}));
        expect(JSON.stringify(ClientCompany.find.mock.calls[0][0])).not.toContain('isSubAccountTx');
        expect(JSON.stringify(ExecutorGroup.find.mock.calls[0][0])).not.toContain('isSubAccountTx');
    });

    test('header account queries stay open in single-tenant even when the request has a tenant id', () => {
        const source = { tenantId: { _bsontype: 'ObjectId', toHexString: () => '507f1f77bcf86cd799439011' } };
        const companyQuery = adminVisibleCompanyQuery(source);
        const executorQuery = adminVisibleExecutorQuery(source);

        expect(companyQuery.tenantId).toBeUndefined();
        expect(companyQuery.isSubAccountTx).toBeUndefined();
        expect(companyQuery.status).toEqual({ $nin: ['deleted', 'inactive', 'archived'] });
        expect(executorQuery.tenantId).toBeUndefined();
        expect(executorQuery.isSubAccountTx).toBeUndefined();
        expect(executorQuery.status).toEqual({ $nin: ['deleted', 'archived'] });
        expect(executorQuery.$or).toEqual(expect.arrayContaining([
            { balance: { $gt: 0 } },
            { isApiBot: true, lastApiServiceCredit: { $gt: 0 } },
            { isApiGroup: true, lastApiServiceCredit: { $gt: 0 } }
        ]));
        expect(successfulOpsLedgerMatch(source).tenantId).toBeUndefined();
        expect(successfulOpsLedgerMatch(source)).toEqual(expect.objectContaining({
            status: 'completed',
            isSubAccountTx: { $ne: true }
        }));
    });

    test('period stats keep a hard tenant boundary in multi-tenant mode and still hide SubAccount ledgers', () => {
        jest.resetModules();
        jest.doMock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'multi' }));
        const scoped = require('../services/centralLedgerOverviewService');
        const tenantId = 'tenant-a';
        expect(scoped.successfulOpsLedgerMatch(tenantId)).toEqual(expect.objectContaining({
            tenantId,
            status: 'completed',
            isSubAccountTx: { $ne: true }
        }));
        expect(scoped.adminVisibleCompanyQuery(tenantId).tenantId).toBe(tenantId);
        expect(scoped.adminVisibleExecutorQuery(tenantId).tenantId).toBe(tenantId);
    });
});
