'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const mockAggregate = (rows) => ({
    option: jest.fn().mockResolvedValue(rows)
});

jest.mock('../models/Transaction', () => ({
    aggregate: jest.fn()
}));
jest.mock('../models/AuditLog', () => ({
    aggregate: jest.fn()
}));

const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');
const { extractRequestCountry } = require('../utils/requestGeo');
const {
    allowDemoHeatmap,
    getGeoHeatmap,
    mergeCountryCounts,
    parseHeatmapWindow
} = require('../services/opsGeoHeatmapService');

describe('ops geo heatmap', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('parses known windows and falls back to 15 minutes', () => {
        const now = new Date('2026-09-18T12:00:00.000Z');
        expect(parseHeatmapWindow('1h', now).from.toISOString()).toBe('2026-09-18T11:00:00.000Z');
        expect(parseHeatmapWindow('nope', now).key).toBe('15m');
        expect(parseHeatmapWindow('24h', now).from.toISOString()).toBe('2026-09-17T12:00:00.000Z');
    });

    test('merges country buckets and drops unknown codes', () => {
        const rows = mergeCountryCounts([
            { _id: 'LY', count: 4 },
            { _id: 'ly', count: 2 },
            { _id: 'XX', count: 9 },
            { _id: 'EG', count: 3 }
        ]);
        expect(rows[0]).toMatchObject({ country: 'LY', count: 6, intensity: 1 });
        expect(rows.map((row) => row.country)).toEqual(['LY', 'EG']);
        expect(rows.find((row) => row.country === 'XX')).toBeUndefined();
    });

    test('never seeds demo traffic in production even with flags', () => {
        expect(allowDemoHeatmap(
            { query: { demo: '1' } },
            { NODE_ENV: 'production', OPS_GEO_DEMO: '1' }
        )).toBe(false);
        expect(allowDemoHeatmap(
            { query: {} },
            { NODE_ENV: 'development', OPS_GEO_DEMO: '1' }
        )).toBe(true);
    });

    test('aggregates stored originCountry with audit country codes and stays tenant-scoped', async () => {
        Transaction.aggregate.mockReturnValue(mockAggregate([{ _id: 'LY', count: 5 }]));
        AuditLog.aggregate.mockReturnValue(mockAggregate([{ _id: 'EG', count: 2 }]));
        const tenantId = '64b000000000000000000001';
        const now = new Date('2026-09-18T12:00:00.000Z');

        const heatmap = await getGeoHeatmap({
            tenantId,
            query: { window: '15m' }
        }, now);

        expect(heatmap.demo).toBe(false);
        expect(heatmap.total).toBe(7);
        expect(heatmap.countries.map((row) => row.country)).toEqual(['LY', 'EG']);
        const txMatch = Transaction.aggregate.mock.calls[0][0][0].$match;
        expect(txMatch.tenantId).toEqual({ $in: [tenantId, null] });
        expect(txMatch.originCountry).toEqual({ $exists: true, $nin: [null, ''] });
        expect(txMatch.createdAt.$gte.toISOString()).toBe('2026-09-18T11:45:00.000Z');
        const auditMatch = AuditLog.aggregate.mock.calls[0][0][0].$match;
        expect(auditMatch.action).toBe('TRANSFER_CREATED');
        expect(auditMatch.tenantId).toEqual({ $in: [tenantId, null] });
    });

    test('returns labeled demo data only in local runtime when there is no geo signal', async () => {
        Transaction.aggregate.mockReturnValue(mockAggregate([]));
        AuditLog.aggregate.mockReturnValue(mockAggregate([]));
        const heatmap = await getGeoHeatmap({
            query: { demo: '1' }
        }, new Date('2026-09-18T12:00:00.000Z'));

        expect(heatmap.demo).toBe(true);
        expect(heatmap.label).toMatch(/تجريبية/);
        expect(heatmap.countries.length).toBeGreaterThan(0);
    });

    test('extracts Cloudflare country headers and ignores anonymized codes', () => {
        expect(extractRequestCountry({ headers: { 'cf-ipcountry': 'ly' } })).toBe('LY');
        expect(extractRequestCountry({ headers: { 'x-country-code': 'XX' } })).toBe('');
        expect(extractRequestCountry({ headers: { 'cf-ipcountry': 'T1' } })).toBe('');
    });
});
