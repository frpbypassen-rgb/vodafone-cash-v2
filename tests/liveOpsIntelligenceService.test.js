'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const {
    amountBand,
    buildTimeFlow,
    buildTrustPath,
    buildWatchdogSuggestions,
    clusterLoadedRows,
    detectFanIn,
    forecastCongestion,
    minuteKey,
    parseMinuteFilter,
    parseWindow,
    scoreDuration
} = require('../services/liveOpsIntelligenceService');

describe('live ops intelligence', () => {
    test('parses known windows and defaults to 15 minutes', () => {
        const now = new Date('2026-09-18T12:00:00.000Z');
        expect(parseWindow('1h', now).from.toISOString()).toBe('2026-09-18T11:00:00.000Z');
        expect(parseWindow('24h', now).from.toISOString()).toBe('2026-09-17T12:00:00.000Z');
        expect(parseWindow('nope', now).key).toBe('15m');
        expect(parseWindow('15m', now).from.toISOString()).toBe('2026-09-18T11:45:00.000Z');
    });

    test('floors minute keys and filters to a 60 second window', () => {
        expect(minuteKey('2026-09-18T12:00:41.500Z')).toBe('2026-09-18T12:00:00.000Z');
        expect(minuteKey('bad')).toBe('');
        const filter = parseMinuteFilter('2026-09-18T12:00:41.000Z');
        expect(filter.$gte.toISOString()).toBe('2026-09-18T12:00:00.000Z');
        expect(filter.$lt.toISOString()).toBe('2026-09-18T12:01:00.000Z');
        expect(parseMinuteFilter('')).toBeNull();
        expect(parseMinuteFilter('not-a-date')).toBeNull();
    });

    test('clusters loaded rows when the same owner hits the threshold in one minute', () => {
        const now = new Date('2026-09-18T12:00:10.000Z');
        const burst = Array.from({ length: 10 }, (_, index) => ({
            id: `tx-${index}`,
            userKey: '0910000001',
            customer: 'شركة النور',
            amount: 100,
            createdAt: now
        }));
        const mixed = burst.concat({
            id: 'other',
            userKey: '0910000002',
            customer: 'آخر',
            amount: 50,
            createdAt: now
        });
        const clusters = clusterLoadedRows(mixed, 10);
        expect(clusters).toHaveLength(1);
        expect(clusters[0]).toMatchObject({
            owner: '0910000001',
            name: 'شركة النور',
            count: 10,
            volume: 1000
        });
        expect(clusterLoadedRows(mixed, 11)).toEqual([]);
    });

    test('detects fan-in when many distinct senders hit one beneficiary', () => {
        expect(detectFanIn([
            { recipient: '010111', senders: 6, count: 12, volume: 900 },
            { recipient: '010222', senders: 2, count: 20, volume: 400 }
        ])).toEqual([
            expect.objectContaining({ recipient: '010111', senders: 6, count: 12 })
        ]);
        expect(detectFanIn([{ recipient: '010111', senders: 4, count: 20 }])).toEqual([]);
    });

    test('flags congestion from same-hour ratio, cold-start volume, or pending backlog', () => {
        expect(forecastCongestion({ currentHourCount: 15, baselineHourAvg: 10, pending: 0 }).flagged).toBe(true);
        expect(forecastCongestion({ currentHourCount: 14, baselineHourAvg: 10, pending: 0 }).flagged).toBe(false);
        expect(forecastCongestion({ currentHourCount: 20, baselineHourAvg: 0, pending: 0 }).flagged).toBe(true);
        expect(forecastCongestion({ currentHourCount: 5, baselineHourAvg: 0, pending: 25 }).flagged).toBe(true);
        expect(forecastCongestion({ currentHourCount: 15, baselineHourAvg: 10 }).message).toContain('متوقع ارتفاع');
    });

    test('builds a trust path from origin country versus audit country', () => {
        expect(buildTrustPath({ originCountry: 'LY', auditCountry: 'ly', ip: '1.1.1.1' })).toMatchObject({
            state: 'consistent',
            consistent: true
        });
        expect(buildTrustPath({ originCountry: 'LY', auditCountry: 'EG' }).state).toBe('mismatch');
        expect(buildTrustPath({ originCountry: 'LY' }).state).toBe('unknown');
        expect(buildTrustPath({}).consistent).toBeNull();
    });

    test('scores similar-op duration as slow only with a real baseline sample', () => {
        expect(scoreDuration({ currentMs: 40000, baselineMs: 15000, sample: 8 }).slow).toBe(true);
        expect(scoreDuration({ currentMs: 40000, baselineMs: 15000, sample: 2 }).slow).toBe(false);
        expect(scoreDuration({ currentMs: 20000, baselineMs: 0, sample: 10 }).slow).toBe(false);
        expect(amountBand(50).key).toBe('0-100');
        expect(amountBand(750).key).toBe('500-2000');
        expect(amountBand(25000).key).toBe('10000+');
    });

    test('emits honest rule-based watchdog cards without claiming an LLM', () => {
        const suggestions = buildWatchdogSuggestions({
            geo: [{ country: 'EG', label: 'مصر', count: 9 }],
            recentTotal: 10,
            failureRate5m: 12,
            fanIn: [{ recipient: '010999', senders: 7, count: 14 }],
            congestion: { flagged: true, message: 'ازدحام' },
            clusters: [{ key: 'u|m', name: 'شركة', owner: 'u1', count: 12, volume: 5000 }]
        });
        expect(suggestions.every((item) => item.source === 'rules')).toBe(true);
        expect(suggestions.map((item) => item.kind)).toEqual(
            expect.arrayContaining(['geo_burst', 'failure_spike', 'fan_in', 'congestion', 'burst'])
        );
        expect(JSON.stringify(suggestions)).not.toMatch(/llm|chatgpt|openai/i);
    });

    test('normalizes time-flow intensity against the busiest minute', () => {
        const flow = buildTimeFlow([
            { minute: '2026-09-18T12:00:00.000Z', total: 10, success: 8, failed: 1, pending: 1 },
            { minute: '2026-09-18T12:01:00.000Z', total: 5, success: 5, failed: 0, pending: 0 }
        ]);
        expect(flow[0].intensity).toBe(1);
        expect(flow[1].intensity).toBe(0.5);
    });
});
