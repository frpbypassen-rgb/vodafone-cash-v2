'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const {
    buildLiveQuery,
    mapLiveTransaction,
    resolveTimeRange
} = require('../services/liveOperationsService');
const { mongoQueryMatches } = require('./mongoQueryMatch');

describe('live operations service', () => {
    test('builds server-side filters without treating the request as a tenant id', () => {
        const request = {
            tenantId: null,
            tenant: null,
            query: { status: 'pending', type: 'vodafone', range: '1h', minAmount: '10000', q: 'ATT-001' }
        };
        const query = buildLiveQuery(request, new Date('2026-09-18T12:00:00.000Z'));
        expect(query.tenantId).toBeUndefined();
        expect(query.status).toEqual({ $in: ['pending', 'processing', 'accepted', 'deposit_pending'] });
        expect(query.transferType).toBe('vodafone');
        expect(query.amount).toEqual({ $gte: 10000 });
        expect(query.createdAt.$gte.toISOString()).toBe('2026-09-18T11:00:00.000Z');
        expect(query.isSubAccountTx).toBeUndefined();
        expect(query.$nor).toEqual(expect.arrayContaining([
            expect.objectContaining({
                status: { $in: ['deposit', 'deduction', 'deposit_pending'] },
                isSubAccountTx: true
            }),
            expect.objectContaining({
                status: { $in: ['deposit', 'deduction', 'deposit_pending'] },
                subAccountId: { $exists: true, $nin: [null] }
            })
        ]));
        query.$nor.forEach((clause) => expect(clause.$or).toBeUndefined());
        expect(query.$or).toHaveLength(8);
        expect(query.$or.some((clause) => clause.subAccountName)).toBe(false);
    });

    test('falls back to a safe 24 hour range when a custom range is invalid', () => {
        const now = new Date('2026-09-18T12:00:00.000Z');
        const range = resolveTimeRange({ range: 'custom', from: 'bad', to: 'bad' }, now);
        expect(range.$gte.toISOString()).toBe('2026-09-17T12:00:00.000Z');
        expect(range.$lte).toBe(now);
    });

    test('maps business filters to the stored transaction fields', () => {
        const deposit = buildLiveQuery({ query: { status: 'pending', type: 'deposit', range: 'all' } });
        expect(deposit.status).toEqual({ $in: ['deposit_pending'] });
        expect(deposit.transferType).toBeUndefined();

        const internal = buildLiveQuery({ query: { type: 'internal_transfer', range: 'all' } });
        expect(internal.transferType).toBe('balance_transfer');

        const cash = buildLiveQuery({ query: { type: 'cash_transfer', range: 'all' } });
        expect(cash.transferType.$in).toContain('vodafone');
        expect(cash.transferType.$in).toContain('bank_account');
    });

    test('marks large transactions and exposes only a safe API error summary', () => {
        const row = mapLiveTransaction({
            _id: 'tx-1', customId: 'ATT-001', status: 'rejected', transferType: 'vodafone',
            amount: 15000, costLYD: 100, createdAt: new Date('2026-09-18T10:00:00Z'),
            apiResultData: { code: 'GATEWAY_TIMEOUT', message: 'Gateway unavailable', token: 'must-not-leak' }
        });
        expect(row.security.largeAmount).toBe(true);
        expect(row.error).toEqual({ code: 'GATEWAY_TIMEOUT', message: 'Gateway unavailable' });
        expect(JSON.stringify(row)).not.toContain('must-not-leak');
    });

    test('does not surface agency client names on live operation rows', () => {
        const row = mapLiveTransaction({
            _id: 'tx-agency',
            customId: 'ATT-AGENCY',
            status: 'completed',
            transferType: 'vodafone',
            amount: 50,
            subAccountName: 'عميل وكالة سري'
        });
        expect(row.customer).toBe('عميل غير محدد');
        expect(JSON.stringify(row)).not.toContain('عميل وكالة سري');
    });

    test('pending sub-client transfers are not excluded from the live ops query', () => {
        const now = new Date('2026-09-20T20:00:00.000Z');
        const query = buildLiveQuery({ query: { status: 'pending', type: 'vodafone', range: 'all' } }, now);
        expect(query.status).toEqual({ $in: ['pending', 'processing', 'accepted', 'deposit_pending'] });
        expect(query.transferType).toBe('vodafone');
        expect(query.isSubAccountTx).toBeUndefined();
        expect(query.$nor).toEqual(expect.arrayContaining([
            expect.objectContaining({
                status: { $in: ['deposit', 'deduction', 'deposit_pending'] },
                isSubAccountTx: true
            }),
            expect.objectContaining({
                status: { $in: ['deposit', 'deduction', 'deposit_pending'] },
                subAccountId: { $exists: true, $nin: [null] }
            })
        ]));
        query.$nor.forEach((clause) => expect(clause.$or).toBeUndefined());

        const pendingSubClient = {
            status: 'pending',
            transferType: 'vodafone',
            isSubAccountTx: true,
            subAccountId: '64b0000000000000000000aa',
            createdAt: now,
            amount: 250
        };
        const agencyDeposit = {
            status: 'deposit',
            transferType: 'vodafone',
            isSubAccountTx: true,
            subAccountId: '64b0000000000000000000aa',
            createdAt: now,
            amount: 250
        };
        expect(mongoQueryMatches(pendingSubClient, query)).toBe(true);
        expect(mongoQueryMatches(agencyDeposit, query)).toBe(false);
        expect(mongoQueryMatches(pendingSubClient, buildLiveQuery({ query: {} }, now))).toBe(true);
        expect(mongoQueryMatches(agencyDeposit, buildLiveQuery({ query: { range: 'all' } }, now))).toBe(false);
    });
});
