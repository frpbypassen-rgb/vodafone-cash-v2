'use strict';

const {
    buildInsights,
    buildPeriods,
    completedInRange,
    fillDailySeries,
    percentageChange
} = require('../services/dashboardIntelligenceService');

describe('Dashboard intelligence calculations', () => {
    test('builds day, rolling-week and calendar-month comparison periods', () => {
        const now = new Date('2026-09-17T12:30:00+02:00');
        const periods = buildPeriods(now);

        expect(periods.todayStart.toISOString()).toBe('2026-09-16T22:00:00.000Z');
        expect(periods.weekStart.toISOString()).toBe('2026-09-10T22:00:00.000Z');
        expect(periods.previousWeekStart.toISOString()).toBe('2026-09-03T22:00:00.000Z');
        expect(periods.currentMonthStart.toISOString()).toBe('2026-08-31T22:00:00.000Z');
        expect(periods.previousMonthStart.toISOString()).toBe('2026-07-31T22:00:00.000Z');
        expect(periods.yesterdayEquivalentEnd.toISOString()).toBe('2026-09-16T10:30:00.000Z');
    });

    test('calculates stable percentage changes including empty baselines', () => {
        expect(percentageChange(120, 100)).toBe(20);
        expect(percentageChange(80, 100)).toBe(-20);
        expect(percentageChange(10, 0)).toBe(100);
        expect(percentageChange(0, 0)).toBe(0);
    });

    test('fills missing chart days with zero values', () => {
        const rows = [{ _id: '2026-09-12', count: 3, amountEGP: 900, costLYD: 120 }];
        const series = fillDailySeries(rows, new Date('2026-09-10T22:00:00.000Z'), 3);

        expect(series).toHaveLength(3);
        expect(series[0]).toMatchObject({ date: '2026-09-11', count: 0, amountEGP: 0 });
        expect(series[1]).toMatchObject({ date: '2026-09-12', count: 3, amountEGP: 900 });
        expect(series[2]).toMatchObject({ date: '2026-09-13', costLYD: 0 });
    });

    test('produces operational insights from metrics, peaks and executor scores', () => {
        const insights = buildInsights({
            metrics: {
                today: { amountEGP: 1500, count: 4 },
                yesterday: { amountEGP: 1000 },
                week: {}, month: {}
            },
            weekly: [{ label: 'الخميس 17', amountEGP: 1500, count: 4 }],
            peakDays: [{ weekdayLabel: 'الخميس', averageAmountEGP: 4200 }],
            executors: [{ name: 'منفذ تجريبي', efficiencyScore: 91, successRate: 98 }],
            todayStatus: { pending: 2, processing: 1 },
            now: new Date('2026-09-17T10:00:00Z')
        });

        expect(insights.map((item) => item.title)).toEqual(expect.arrayContaining([
            'نشاط اليوم أعلى من المعتاد',
            'أقوى يوم هذا الأسبوع',
            'نمط ذروة متكرر',
            'المنفذ الأعلى كفاءة'
        ]));
    });

    test('filters dashboard metrics with indexable completedAt or createdAt ranges', () => {
        const start = new Date('2026-09-16T22:00:00.000Z');
        const end = new Date('2026-09-17T12:00:00.000Z');
        expect(JSON.stringify(completedInRange(start, end))).not.toMatch(/\$expr/);
        expect(completedInRange(start, end)).toEqual({
            $or: [
                { completedAt: { $gte: start, $lte: end } },
                { $and: [
                    { $or: [{ completedAt: { $exists: false } }, { completedAt: null }] },
                    { createdAt: { $gte: start, $lte: end } }
                ] }
            ]
        });
    });
});
