'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const {
    OPERATIONS_TODAY_BANK_TYPES,
    activeExecutorStripQuery,
    buildOperationsDayFacetPipeline,
    isOperationsTodayBankChannel,
    loadOperationsSummaryStrip,
    mapActiveExecutorStrip,
    mapCompanyStrip,
    mapTodayTotals
} = require('../services/operationsSummaryStripService');

describe('operations summary strip', () => {
    test('scans today once and splits completed totals from company deposits', () => {
        const pipeline = buildOperationsDayFacetPipeline({}, new Date('2026-09-19T12:00:00+02:00'));
        const match = pipeline[0].$match;
        const facet = pipeline[1].$facet;

        expect(match.status).toEqual({ $in: ['completed', 'deposit'] });
        expect(match.createdAt.$gte.toISOString()).toBe('2026-09-18T22:00:00.000Z');
        expect(match.$nor).toEqual(expect.any(Array));
        expect(facet.totals[0].$match).toEqual({
            status: 'completed',
            $or: [
                { transferType: { $ne: 'balance_transfer' } },
                { customId: { $not: /-C$/ } }
            ]
        });
        const group = facet.totals[1].$group;
        const amount = { $ifNull: ['$amount', 0] };
        const costLYD = { $ifNull: ['$costLYD', 0] };
        const isBank = {
            $or: [
                { $in: [{ $toLower: { $ifNull: ['$transferType', ''] } }, OPERATIONS_TODAY_BANK_TYPES] },
                { $in: [{ $toLower: { $ifNull: ['$canonicalServiceKey', ''] } }, OPERATIONS_TODAY_BANK_TYPES] }
            ]
        };
        expect(OPERATIONS_TODAY_BANK_TYPES).toEqual(expect.arrayContaining(['bank_account', 'bank_transfer', 'instapay']));
        expect(group.egyptianEGP).toEqual({ $sum: amount });
        expect(group.libyanLYD).toEqual({ $sum: costLYD });
        expect(group.cashEGP).toEqual({ $sum: { $cond: [isBank, 0, amount] } });
        expect(group.bankEGP).toEqual({ $sum: { $cond: [isBank, amount, 0] } });
        expect(group.cashLYD).toEqual({ $sum: { $cond: [isBank, 0, costLYD] } });
        expect(group.bankLYD).toEqual({ $sum: { $cond: [isBank, costLYD, 0] } });
        expect(facet.completedByCompany[0].$match.companyId).toEqual({ $exists: true, $ne: null });
        expect(facet.depositsByCompany[0].$match).toEqual({
            status: 'deposit',
            companyId: { $exists: true, $ne: null }
        });
        expect(facet.depositsByCompany[1].$group.total).toEqual({ $sum: { $ifNull: ['$amount', 0] } });
        expect(facet.completedByExecutor[0].$match).toEqual({
            status: 'completed',
            executorGroupId: { $exists: true, $ne: null },
            $or: [
                { transferType: { $ne: 'balance_transfer' } },
                { customId: { $not: /-C$/ } }
            ]
        });
        expect(facet.completedByExecutor[1].$group).toEqual({ _id: '$executorGroupId', count: { $sum: 1 } });
        expect(facet.depositsByExecutor[0].$match).toEqual({
            status: 'deposit',
            executorGroupId: { $exists: true, $ne: null },
            companyId: null
        });
        expect(facet.depositsByExecutor[1].$group.total).toEqual({ $sum: { $ifNull: ['$amount', 0] } });
    });

    test('keeps every active executor and uses pool total or cached API credit', () => {
        const mapped = mapActiveExecutorStrip([
            { _id: 'e1', name: 'منفذ كاش', balance: 100, serviceKey: 'vodafone' },
            { _id: 'e2', name: 'API', balance: -20, isApiBot: true, lastApiServiceCredit: 90, serviceKey: 'vodafone' },
            { _id: 'e3', name: 'منفذ صفر', balance: 0, serviceKey: 'vodafone' },
            { _id: 'e4', name: 'API بلا فحص', balance: 40, isApiGroup: true, lastApiServiceCredit: null, serviceKey: 'vodafone' }
        ], new Map([['e1', 25]]));

        expect(mapped.map((row) => row.id)).toEqual(['e1', 'e2', 'e4', 'e3']);
        expect(mapped.find((row) => row.id === 'e1')).toMatchObject({ balance: 125, balanceSource: 'internal' });
        expect(mapped.find((row) => row.id === 'e2')).toMatchObject({ balance: 90, balanceSource: 'api_service' });
        expect(mapped.find((row) => row.id === 'e3').balance).toBe(0);
        expect(mapped.find((row) => row.id === 'e4')).toMatchObject({ balance: 40, balanceSource: 'internal' });
        expect(mapped.every((row) => row.completedToday === 0 && row.depositsToday === 0)).toBe(true);
        expect(activeExecutorStripQuery({}).status).toBe('active');
        expect(activeExecutorStripQuery({}).isManagerBot).toEqual({ $ne: true });
        expect(activeExecutorStripQuery({}).isManagerGroup).toEqual({ $ne: true });
    });

    test('attaches today completed counts and deposit totals onto executor balances', () => {
        const mapped = mapActiveExecutorStrip(
            [
                { _id: 'e1', name: 'منفذ كاش', balance: 10, serviceKey: 'vodafone' },
                { _id: 'e2', name: 'منفذ هادئ', balance: 0, serviceKey: 'vodafone' }
            ],
            new Map(),
            new Map([['e1', 4]]),
            new Map([['e1', 750.5]])
        );

        expect(mapped.find((row) => row.id === 'e1')).toMatchObject({ completedToday: 4, depositsToday: 750.5 });
        expect(mapped.find((row) => row.id === 'e2')).toMatchObject({ completedToday: 0, depositsToday: 0 });
    });

    test('attaches today completed counts and deposit totals onto company balances', () => {
        const companies = mapCompanyStrip(
            [
                { id: 'c1', name: 'شركة النور', balance: 88.5 },
                { id: 'c2', name: 'شركة الأمل', balance: 0 }
            ],
            new Map([['c1', 7]]),
            new Map([['c1', 900]])
        );

        expect(companies).toEqual([
            { id: 'c1', name: 'شركة النور', balance: 88.5, completedToday: 7, depositsToday: 900 },
            { id: 'c2', name: 'شركة الأمل', balance: 0, completedToday: 0, depositsToday: 0 }
        ]);
    });

    test('treats bank_account, bank_transfer, and instapay as the bank channel', () => {
        expect(isOperationsTodayBankChannel({ transferType: 'vodafone' })).toBe(false);
        expect(isOperationsTodayBankChannel({ transferType: 'post_account' })).toBe(false);
        expect(isOperationsTodayBankChannel({ transferType: 'sefa_niger' })).toBe(false);
        expect(isOperationsTodayBankChannel({ transferType: 'bank_account', serviceSubtype: 'instapay' })).toBe(true);
        expect(isOperationsTodayBankChannel({ transferType: 'bank_transfer' })).toBe(true);
        expect(isOperationsTodayBankChannel({ transferType: 'Instapay' })).toBe(true);
        expect(isOperationsTodayBankChannel({
            transferType: 'vodafone',
            canonicalServiceKey: 'bank_account'
        })).toBe(true);
        expect(isOperationsTodayBankChannel({})).toBe(false);
    });

    test('sums stored cash and bank costLYD into the LYD total', () => {
        expect(mapTodayTotals({
            egyptianEGP: 12400.5,
            libyanLYD: 2310.25,
            cashEGP: 10000.5,
            bankEGP: 2400,
            cashLYD: 1900.25,
            bankLYD: 410
        })).toEqual({
            egyptianEGP: 12400.5,
            libyanLYD: 2310.25,
            cashEGP: 10000.5,
            bankEGP: 2400,
            totalLYD: 2310.25
        });
        expect(mapTodayTotals({})).toEqual({
            egyptianEGP: 0,
            libyanLYD: 0,
            cashEGP: 0,
            bankEGP: 0,
            totalLYD: 0
        });
    });

    test('loads the day facet, companies, and active executors together', async () => {
        const Transaction = {
            aggregate: jest.fn().mockResolvedValue([{
                totals: [{
                    egyptianEGP: 12400.5,
                    libyanLYD: 2310.25,
                    cashEGP: 10000.5,
                    bankEGP: 2400,
                    cashLYD: 1900.25,
                    bankLYD: 410
                }],
                completedByCompany: [{ _id: 'c1', count: 3 }],
                depositsByCompany: [{ _id: 'c1', total: 150 }, { _id: 'archived-co', total: 20 }],
                completedByExecutor: [{ _id: 'e1', count: 5 }],
                depositsByExecutor: [{ _id: 'e1', total: 400 }, { _id: 'other-executor', total: 25 }]
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
                    { _id: 'e1', name: 'منفذ أ', balance: 50, serviceKey: 'vodafone' }
                ])
            })
        };

        const summary = await loadOperationsSummaryStrip({
            Transaction,
            ClientCompany,
            ExecutorGroup,
            source: {},
            now: new Date('2026-09-19T10:00:00+02:00')
        });

        expect(Transaction.aggregate).toHaveBeenCalledTimes(1);
        expect(summary.today).toEqual({
            egyptianEGP: 12400.5,
            libyanLYD: 2310.25,
            cashEGP: 10000.5,
            bankEGP: 2400,
            totalLYD: 2310.25
        });
        expect(summary.todayDepositsTotal).toBe(170);
        expect(summary.todayExecutorDepositsTotal).toBe(425);
        expect(summary.companies).toEqual([
            expect.objectContaining({ id: 'c1', balance: 12, completedToday: 3, depositsToday: 150 })
        ]);
        expect(summary.activeExecutors).toEqual([
            expect.objectContaining({ id: 'e1', name: 'منفذ أ', balance: 50, completedToday: 5, depositsToday: 400 })
        ]);
        expect(ExecutorGroup.find).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    });
});
