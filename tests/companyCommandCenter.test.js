'use strict';

const {
    staffRoleLabel,
    presenceStatus,
    fillWeekdaySeries,
    mergeEmployeeStats,
    ONLINE_WINDOW_MINUTES
} = require('../services/companyCommandCenterService');

describe('company command center helpers', () => {
    test('maps stored roles to Arabic labels', () => {
        expect(staffRoleLabel({ role: 'owner' })).toBe('مالك');
        expect(staffRoleLabel({ role: 'accountant' })).toBe('محاسب');
        expect(staffRoleLabel({ role: 'employee', canManageCompany: true })).toBe('مدير تشغيل');
        expect(staffRoleLabel({ role: 'employee', corporateRole: 'manager' })).toBe('مدير تشغيل');
        expect(staffRoleLabel({ role: 'employee' })).toBe('موظف تنفيذ');
    });

    test('marks presence from account status and last-seen window', () => {
        const now = new Date('2026-09-19T12:00:00Z');
        expect(presenceStatus({ status: 'inactive', lastSeenAt: now, now })).toMatchObject({
            accountActive: false,
            isOnline: false,
            presenceLabel: 'موقوف',
            accountLabel: 'موقوف'
        });
        expect(presenceStatus({
            status: 'active',
            lastSeenAt: new Date(now.getTime() - (ONLINE_WINDOW_MINUTES - 1) * 60 * 1000),
            now
        })).toMatchObject({ isOnline: true, presenceLabel: 'متصل' });
        expect(presenceStatus({
            status: 'active',
            lastSeenAt: new Date(now.getTime() - (ONLINE_WINDOW_MINUTES + 2) * 60 * 1000),
            now
        })).toMatchObject({ isOnline: false, presenceLabel: 'غير متصل' });
        expect(presenceStatus({ status: 'active', lastSeenAt: null, now })).toMatchObject({
            isOnline: false,
            presenceLabel: 'غير متصل'
        });
    });

    test('fills missing weekday chart days with zeros', () => {
        const rows = [{ _id: '2026-09-12', count: 3, amountEGP: 900, costLYD: 120 }];
        const series = fillWeekdaySeries(rows, new Date('2026-09-10T22:00:00.000Z'), 3);

        expect(series).toHaveLength(3);
        expect(series[0]).toMatchObject({ date: '2026-09-11', count: 0, amountEGP: 0 });
        expect(series[1]).toMatchObject({ date: '2026-09-12', count: 3, amountEGP: 900 });
        expect(series[2]).toMatchObject({ date: '2026-09-13', costLYD: 0 });
        expect(series[1].label).toBeTruthy();
        expect(series[1].shortLabel).toBeTruthy();
    });

    test('merges employee ops from actor id and legacy name rows', () => {
        const member = { _id: 'emp1', name: 'أحمد' };
        const stats = mergeEmployeeStats(member, [
            { _id: { actorId: 'emp1', name: 'أحمد' }, totalCount: 2, completedCount: 1, todayCount: 1, totalEGP: 400, todayEGP: 200, lastActivity: new Date('2026-09-18T10:00:00Z') },
            { actorId: '', name: 'أحمد', totalCount: 1, completedCount: 1, todayCount: 0, totalEGP: 150, lastActivity: new Date('2026-09-19T08:00:00Z') }
        ]);
        expect(stats).toMatchObject({ totalCount: 3, completedCount: 2, todayCount: 1, totalEGP: 550 });
        expect(new Date(stats.lastActivity).toISOString()).toBe('2026-09-19T08:00:00.000Z');
    });
});
