'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const mockAggregate = (rows) => ({
    option: jest.fn().mockResolvedValue(rows)
});

jest.mock('../models/Transaction', () => ({
    aggregate: jest.fn()
}));
jest.mock('../models/User', () => ({
    findOne: jest.fn()
}));
jest.mock('../models/ClientCompany', () => ({
    findOne: jest.fn()
}));

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const {
    buildComparison,
    compareClientBehavior,
    normalizeBaseline,
    ownerMatch,
    scoreMetric
} = require('../services/clientBehaviorComparisonService');

describe('client behavior comparison', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('flags metrics that are at least 2x the daily baseline', () => {
        expect(scoreMetric(20, 8).flagged).toBe(true);
        expect(scoreMetric(10, 8).flagged).toBe(false);
        expect(scoreMetric(5, 0).flagged).toBe(true);
        expect(scoreMetric(1, 0).flagged).toBe(false);
    });

    test('normalizes 30-day totals into a per-day baseline', () => {
        const baseline = normalizeBaseline({
            transferCount: 60,
            totalVolume: 3000,
            avgAmount: 50,
            distinctRecipients: 15,
            failureRate: 0.1,
            nightShare: 0.2
        }, 30);
        expect(baseline.transferCount).toBe(2);
        expect(baseline.totalVolume).toBe(100);
        expect(baseline.avgAmount).toBe(50);
        expect(baseline.failureRate).toBe(0.1);
    });

    test('marks a burst of transfers as unusual versus the historical average', () => {
        const comparison = buildComparison(
            { count: 12, volume: 24000, avgAmount: 2000, recipients: ['a', 'b', 'c'], failed: 0, nightCount: 1 },
            { count: 30, volume: 15000, avgAmount: 500, recipients: ['a'], failed: 1, nightCount: 2 },
            30
        );
        expect(comparison.metrics.transferCount.flagged).toBe(true);
        expect(comparison.metrics.totalVolume.flagged).toBe(true);
        expect(comparison.unusual).toBe(true);
        expect(comparison.flags).toEqual(expect.arrayContaining(['transferCount', 'totalVolume']));
    });

    test('builds an index-friendly owner match for users and companies', () => {
        expect(ownerMatch({ companyId: 'c1' })).toEqual({ companyId: 'c1' });
        expect(ownerMatch({ userKeys: ['091', '', 'user-1'] })).toEqual({
            companyId: null,
            userId: { $in: ['091', 'user-1'] }
        });
        expect(ownerMatch({ userKeys: [] })).toBeNull();
    });

    test('aggregates current 24h vs previous 30 days for a resolved user', async () => {
        User.findOne.mockReturnValue({
            select: () => ({
                lean: async () => ({
                    _id: '64b0000000000000000000aa',
                    name: 'أحمد',
                    phone: '0910000001',
                    webUsername: 'ahmed',
                    role: 'user'
                })
            })
        });
        Transaction.aggregate.mockReturnValue(mockAggregate([
            { _id: 'current', count: 8, volume: 8000, avgAmount: 1000, recipients: ['1', '2'], failed: 2, nightCount: 4 },
            { _id: 'baseline', count: 30, volume: 6000, avgAmount: 200, recipients: ['1'], failed: 1, nightCount: 3 }
        ]));

        const now = new Date('2026-09-18T12:00:00.000Z');
        const result = await compareClientBehavior({
            tenantId: '64b000000000000000000001',
            query: {}
        }, { id: '0910000001', type: 'user' }, now);

        expect(result.subject.name).toBe('أحمد');
        expect(result.window.current).toBe('24h');
        expect(result.window.baseline).toBe('30d_daily_avg');
        expect(result.metrics.transferCount.current).toBe(8);
        expect(result.metrics.failureRate.flagged).toBe(true);
        const match = Transaction.aggregate.mock.calls[0][0][0].$match;
        expect(match.userId.$in).toEqual(expect.arrayContaining(['0910000001', 'ahmed']));
        expect(match.companyId).toBeNull();
        expect(match.createdAt.$gte.toISOString()).toBe('2026-08-18T12:00:00.000Z');
        expect(Transaction.aggregate.mock.calls[0][0][0]).not.toHaveProperty('$lookup');
    });

    test('returns null without scanning when the client is missing', async () => {
        User.findOne.mockReturnValue({
            select: () => ({ lean: async () => null })
        });
        const result = await compareClientBehavior({ query: {} }, { id: 'missing', type: 'user' });
        expect(result).toBeNull();
        expect(Transaction.aggregate).not.toHaveBeenCalled();
        expect(ClientCompany.findOne).not.toHaveBeenCalled();
    });
});
