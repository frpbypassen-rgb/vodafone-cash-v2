'use strict';

const { isStaticOrNoisePath } = require('../services/systemMonitorService');

describe('System monitor request filtering', () => {
    test('ignores high-frequency refresh endpoints', () => {
        expect(isStaticOrNoisePath('/executor-portal/api/live-tasks')).toBe(true);
        expect(isStaticOrNoisePath('/client/api/transactions?date=2026-08-08')).toBe(true);
        expect(isStaticOrNoisePath('/api/sidebar-stats')).toBe(true);
    });

    test('keeps normal navigation requests visible in the monitor', () => {
        expect(isStaticOrNoisePath('/transactions')).toBe(false);
        expect(isStaticOrNoisePath('/reports')).toBe(false);
    });
});
