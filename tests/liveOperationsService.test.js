'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const {
    buildLiveQuery,
    mapLiveTransaction,
    resolveTimeRange
} = require('../services/liveOperationsService');

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
        expect(query.$or).toHaveLength(8);
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
        expect(row.originCountry).toBe('');
        expect(row.companyId).toBe('');
        expect(row.userKey).toBe('');
        expect(JSON.stringify(row)).not.toContain('must-not-leak');
    });

    test('exposes company and user keys for behavior comparison', () => {
        const row = mapLiveTransaction({
            _id: 'tx-2', customId: 'ATT-002', status: 'completed', transferType: 'vodafone',
            amount: 120, userId: '0910000001', companyId: '64b0000000000000000000cc',
            originCountry: 'LY', createdAt: new Date('2026-09-18T10:00:00Z')
        });
        expect(row.userKey).toBe('0910000001');
        expect(row.companyId).toBe('64b0000000000000000000cc');
        expect(row.originCountry).toBe('LY');
        expect(row.minute).toBe('2026-09-18T10:00:00.000Z');
    });

    test('minute filter replaces the selected range with a single UTC minute', () => {
        const now = new Date('2026-09-18T12:00:00.000Z');
        const query = buildLiveQuery({
            query: { range: '24h', minute: '2026-09-18T11:04:41.000Z' }
        }, now);
        expect(query.createdAt.$gte.toISOString()).toBe('2026-09-18T11:04:00.000Z');
        expect(query.createdAt.$lt.toISOString()).toBe('2026-09-18T11:05:00.000Z');
    });

    test('ids filter keeps at most 100 valid ObjectIds and ignores junk', () => {
        const valid = '64b000000000000000000001';
        const query = buildLiveQuery({
            query: { ids: `${valid},not-an-id,${valid.replace(/1$/, '2')}` }
        });
        expect(query._id.$in).toHaveLength(2);
        expect(String(query._id.$in[0])).toBe(valid);
    });
});
