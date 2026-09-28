'use strict';

const ClientEmployee = require('../models/ClientEmployee');
const SecurityDevice = require('../models/SecurityDevice');
const Transaction = require('../models/Transaction');
const { SYSTEM_TIME_ZONE, systemDateKey } = require('../config/systemTime');

const ONLINE_WINDOW_MINUTES = 10;
const ONLINE_WINDOW_MS = ONLINE_WINDOW_MINUTES * 60 * 1000;
const WEEKDAY_COUNT = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const NON_OPS_STATUSES = Object.freeze(['deposit', 'deposit_pending', 'deduction']);

const emptyOps = () => ({
    totalCount: 0,
    completedCount: 0,
    pendingCount: 0,
    totalEGP: 0,
    todayCount: 0,
    todayEGP: 0,
    lastActivity: null
});

const staffRoleLabel = (member = {}) => {
    if (member.role === 'owner') return 'مالك';
    if (member.role === 'accountant' || member.corporateRole === 'accountant') return 'محاسب';
    if (member.canManageCompany === true || member.corporateRole === 'manager') return 'مدير تشغيل';
    return 'موظف تنفيذ';
};

const presenceStatus = ({ status, lastSeenAt, now = new Date() } = {}) => {
    const accountActive = status === 'active';
    const seen = lastSeenAt ? new Date(lastSeenAt) : null;
    const validSeen = seen && !Number.isNaN(seen.getTime()) ? seen : null;
    const isOnline = accountActive && Boolean(validSeen) && (now.getTime() - validSeen.getTime()) <= ONLINE_WINDOW_MS;
    return {
        accountActive,
        isOnline,
        presenceLabel: !accountActive ? 'موقوف' : (isOnline ? 'متصل' : 'غير متصل'),
        accountLabel: accountActive ? 'نشط' : 'موقوف',
        presenceTone: !accountActive ? 'danger' : (isOnline ? 'success' : 'neutral'),
        lastSeenAt: validSeen
    };
};

const fillWeekdaySeries = (rows = [], startDate, days = WEEKDAY_COUNT) => {
    const start = startDate instanceof Date ? startDate : new Date(startDate);
    const rowMap = new Map((rows || []).map((row) => [String(row._id || row.date || ''), row]));
    return Array.from({ length: days }, (_, index) => {
        const date = new Date(start.getTime() + (index * DAY_MS));
        const key = systemDateKey(date);
        const row = rowMap.get(key) || {};
        return {
            date: key,
            label: new Intl.DateTimeFormat('ar', { timeZone: SYSTEM_TIME_ZONE, weekday: 'long' }).format(date),
            shortLabel: new Intl.DateTimeFormat('ar', { timeZone: SYSTEM_TIME_ZONE, weekday: 'short' }).format(date),
            count: Number(row.count || row.totalCount) || 0,
            completedCount: Number(row.completedCount) || 0,
            amountEGP: Number(row.amountEGP || row.totalEGP) || 0,
            costLYD: Number(row.costLYD || row.totalLYD) || 0
        };
    });
};

const flattenStatsRow = (row = {}) => ({
    actorId: String(row.actorId || row._id?.actorId || ''),
    name: String(row.name || row._id?.name || ''),
    totalCount: Number(row.totalCount) || 0,
    completedCount: Number(row.completedCount) || 0,
    pendingCount: Number(row.pendingCount) || 0,
    totalEGP: Number(row.totalEGP) || 0,
    todayCount: Number(row.todayCount) || 0,
    todayEGP: Number(row.todayEGP) || 0,
    lastActivity: row.lastActivity || null
});

const mergeEmployeeStats = (member, rows = []) => {
    const id = String(member?._id || '');
    const name = String(member?.name || '');
    const matched = (rows || []).map(flattenStatsRow).filter((row) => {
        if (row.actorId && id && row.actorId === id) return true;
        if (!row.actorId && row.name && name && row.name === name) return true;
        return false;
    });
    return matched.reduce((acc, row) => {
        const lastActivity = row.lastActivity && (!acc.lastActivity || new Date(row.lastActivity) > new Date(acc.lastActivity))
            ? row.lastActivity
            : acc.lastActivity;
        return {
            totalCount: acc.totalCount + row.totalCount,
            completedCount: acc.completedCount + row.completedCount,
            pendingCount: acc.pendingCount + row.pendingCount,
            totalEGP: acc.totalEGP + row.totalEGP,
            todayCount: acc.todayCount + row.todayCount,
            todayEGP: acc.todayEGP + row.todayEGP,
            lastActivity
        };
    }, emptyOps());
};

const redactValues = (summary, canViewBalance) => {
    if (canViewBalance) return summary;
    return { ...summary, totalEGP: 0, totalLYD: 0, todayEGP: 0 };
};

const loadCompanyCommandCenter = async ({
    workspace,
    ownership,
    todayRange,
    weekRange,
    monthRange,
    summarize
}) => {
    const canSeeStaff = Boolean(workspace.permissions.manager || workspace.permissions.accountant);
    const canViewBalance = workspace.permissions.canViewBalance === true;
    const weekSummary = await summarize({
        $and: [ownership, { createdAt: { $gte: weekRange.start, $lte: weekRange.end } }]
    });
    const weekdayRows = await Transaction.aggregate([
        {
            $match: {
                $and: [
                    ownership,
                    { createdAt: { $gte: weekRange.start, $lte: weekRange.end } },
                    { status: { $nin: NON_OPS_STATUSES } }
                ]
            }
        },
        {
            $group: {
                _id: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$createdAt',
                        timezone: SYSTEM_TIME_ZONE
                    }
                },
                count: { $sum: 1 },
                completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                amountEGP: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$amount', 0] }, 0] } },
                costLYD: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$costLYD', 0] }, 0] } }
            }
        }
    ]);
    const weekdaySeries = fillWeekdaySeries(weekdayRows, weekRange.start, WEEKDAY_COUNT)
        .map((row) => (canViewBalance ? row : { ...row, amountEGP: 0, costLYD: 0 }));

    let employeeRoster = [];
    if (canSeeStaff) {
        const staff = await ClientEmployee.find({
            companyId: workspace.entity._id,
            $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }]
        }).select('name role status corporateRole canManageCompany webUsername phone').sort({ role: 1, name: 1 }).lean();

        const ids = staff.map((member) => String(member._id));
        const names = staff.map((member) => member.name).filter(Boolean);
        const [devices, statsRows] = await Promise.all([
            ids.length
                ? SecurityDevice.find({
                    principalType: 'client_company',
                    principalId: { $in: ids }
                }).select('principalId lastSeenAt status').sort({ lastSeenAt: -1 }).lean()
                : Promise.resolve([]),
            names.length || ids.length
                ? Transaction.aggregate([
                    {
                        $match: {
                            $and: [
                                ownership,
                                { createdAt: { $gte: monthRange.start, $lte: monthRange.end } },
                                { status: { $nin: NON_OPS_STATUSES } },
                                {
                                    $or: [
                                        ids.length ? { clientActorId: { $in: ids } } : { clientActorId: '__none__' },
                                        names.length ? { employeeName: { $in: names } } : { employeeName: '__none__' }
                                    ]
                                }
                            ]
                        }
                    },
                    {
                        $group: {
                            _id: {
                                actorId: { $ifNull: ['$clientActorId', ''] },
                                name: { $ifNull: ['$employeeName', ''] }
                            },
                            totalCount: { $sum: 1 },
                            completedCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                            pendingCount: { $sum: { $cond: [{ $in: ['$status', ['pending', 'processing', 'accepted']] }, 1, 0] } },
                            totalEGP: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$amount', 0] }, 0] } },
                            todayCount: { $sum: { $cond: [{ $gte: ['$createdAt', todayRange.start] }, 1, 0] } },
                            todayEGP: {
                                $sum: {
                                    $cond: [{
                                        $and: [
                                            { $gte: ['$createdAt', todayRange.start] },
                                            { $eq: ['$status', 'completed'] }
                                        ]
                                    }, { $ifNull: ['$amount', 0] }, 0]
                                }
                            },
                            lastActivity: { $max: '$createdAt' }
                        }
                    }
                ])
                : Promise.resolve([])
        ]);

        const lastSeenById = new Map();
        devices.forEach((device) => {
            const key = String(device.principalId);
            if (!lastSeenById.has(key) || (device.lastSeenAt && device.lastSeenAt > lastSeenById.get(key))) {
                lastSeenById.set(key, device.lastSeenAt || null);
            }
        });

        const now = new Date();
        employeeRoster = staff.map((member) => {
            const ops = redactValues(mergeEmployeeStats(member, statsRows), canViewBalance);
            const presence = presenceStatus({
                status: member.status,
                lastSeenAt: lastSeenById.get(String(member._id)) || ops.lastActivity,
                now
            });
            return {
                id: String(member._id),
                name: member.name,
                webUsername: member.webUsername || '',
                phone: member.phone || '',
                role: member.role,
                roleLabel: staffRoleLabel(member),
                status: member.status,
                accountLabel: presence.accountLabel,
                presenceLabel: presence.presenceLabel,
                presenceTone: presence.presenceTone,
                isOnline: presence.isOnline,
                accountActive: presence.accountActive,
                lastSeenAt: presence.lastSeenAt,
                ops
            };
        });
    }

    return {
        weekSummary: redactValues(weekSummary, canViewBalance),
        weekdaySeries,
        employeeRoster,
        onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
        commandCenterChart: {
            labels: weekdaySeries.map((row) => row.shortLabel || row.label),
            counts: weekdaySeries.map((row) => row.count),
            values: canViewBalance ? weekdaySeries.map((row) => row.amountEGP) : [],
            showValues: canViewBalance
        }
    };
};

module.exports = {
    ONLINE_WINDOW_MINUTES,
    emptyOps,
    staffRoleLabel,
    presenceStatus,
    fillWeekdaySeries,
    mergeEmployeeStats,
    loadCompanyCommandCenter
};
