'use strict';

jest.mock('../models/Transaction', () => ({
    find: jest.fn(),
    updateMany: jest.fn(),
    aggregate: jest.fn()
}));

const Transaction = require('../models/Transaction');
const {
    COMPLETED_TODAY_LIMIT,
    DEP_ALERT_LIMIT,
    IDLE_POLL_INTERVAL_SECONDS,
    BUSY_POLL_INTERVAL_SECONDS,
    LIVE_TASK_PROJECTION,
    completedTodayQuery,
    depositAlertQuery,
    loadPortalLiveTasks,
    pollIntervalSecondsFor
} = require('../services/executorLiveTasksService');

const chain = (result) => ({
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result)
});

describe('executor live-tasks hot path', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Transaction.updateMany.mockResolvedValue({ modifiedCount: 0 });
        Transaction.aggregate.mockResolvedValue([]);
    });

    test('completed-today uses indexed completedAt/updatedAt instead of a four-way date $or', () => {
        const query = completedTodayQuery({
            _id: 'employee-1',
            role: 'operator',
            groupId: 'group-1'
        }, new Date('2026-09-21T10:00:00.000Z'));

        const serialized = JSON.stringify(query);
        expect(serialized).toContain('"status":"completed"');
        expect(serialized).toContain('completedAt');
        expect(serialized).toContain('updatedAt');
        expect(serialized).not.toContain('createdAt');
        expect(serialized).not.toContain('executorReceivedAt');
        expect(query.$and[1]).toEqual({ operatorId: 'employee-1' });
    });

    test('loads live tasks with a lean projection and derives alerts without a second collection scan', async () => {
        const liveQuery = chain([{
            _id: 'task-1',
            status: 'processing',
            emergencyAlert: 'delayed',
            notifiedExecutors: true,
            autoAlertFired: true,
            executorReceivedAt: new Date(),
            createdAt: new Date(),
            amount: 100,
            customId: 'ATT-1'
        }]);
        const depQuery = chain([]);
        const completedQuery = chain([]);
        Transaction.find
            .mockReturnValueOnce(liveQuery)
            .mockReturnValueOnce(depQuery)
            .mockReturnValueOnce(completedQuery);
        Transaction.aggregate.mockResolvedValue([{ count: 2, amount: 250 }]);

        const payload = await loadPortalLiveTasks({
            emp: { _id: 'employee-1', role: 'operator', groupId: 'group-1' }
        });

        expect(liveQuery.select).toHaveBeenCalledWith(LIVE_TASK_PROJECTION);
        expect(Transaction.find).toHaveBeenCalledTimes(3);
        expect(payload.alerts).toHaveLength(1);
        expect(payload.alerts[0]._id).toBe('task-1');
        expect(payload.completedTodaySummary).toEqual({ count: 2, amount: 250 });
        expect(payload.pollIntervalSeconds).toBe(BUSY_POLL_INTERVAL_SECONDS);
        expect(depQuery.limit).toHaveBeenCalledWith(DEP_ALERT_LIMIT);
        expect(completedQuery.limit).toHaveBeenCalledWith(COMPLETED_TODAY_LIMIT);
    });

    test('lite mode skips the completed list and idle queues poll less often', async () => {
        Transaction.find
            .mockReturnValueOnce(chain([]))
            .mockReturnValueOnce(chain([]));
        Transaction.aggregate.mockResolvedValue([{ count: 4, amount: 800 }]);

        const payload = await loadPortalLiveTasks({
            emp: { _id: 'employee-1', role: 'manager', groupId: { _id: 'group-1', manualTaskRoutingEnabled: true } },
            includeCompletedList: false
        });

        expect(Transaction.find).toHaveBeenCalledTimes(2);
        expect(payload.completedToday).toEqual([]);
        expect(payload.completedTodaySummary).toEqual({ count: 4, amount: 800 });
        expect(payload.pollIntervalSeconds).toBe(IDLE_POLL_INTERVAL_SECONDS);
        expect(payload.canRouteTasks).toBe(true);
    });

    test('poll interval stays short while a live task is in the queue', () => {
        expect(pollIntervalSecondsFor([{ status: 'processing' }])).toBe(BUSY_POLL_INTERVAL_SECONDS);
        expect(pollIntervalSecondsFor([])).toBe(IDLE_POLL_INTERVAL_SECONDS);
    });

    test('external funding alerts are scoped to the recipient instead of the whole company', () => {
        const query = depositAlertQuery({ _id: 'ahmed', groupId: 'group-1' }, Date.parse('2026-09-21T10:00:00.000Z'));
        expect(query.$and[2].$or[0]).toEqual({ operatorId: 'ahmed', transferType: 'external_balance' });
        expect(query.$and[2].$or[1]).toEqual(expect.objectContaining({
            transferType: { $ne: 'external_balance' }
        }));
        expect(DEP_ALERT_LIMIT).toBeGreaterThan(0);
        expect(COMPLETED_TODAY_LIMIT).toBeGreaterThan(0);
    });
});
