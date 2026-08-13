'use strict';

jest.mock('../models/Employee');
jest.mock('../models/Transaction');
jest.mock('../services/lockService', () => ({
    acquireLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
    releaseLock: jest.fn().mockResolvedValue(true)
}));

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { acquireLock, releaseLock } = require('../services/lockService');
const {
    taskOwnershipFilter,
    acceptExecutorTask,
    routeExecutorTask
} = require('../services/executorTaskRoutingService');

const manager = {
    _id: 'manager-1',
    name: 'مدير التنفيذ',
    role: 'manager',
    groupId: { _id: 'group-1', manualTaskRoutingEnabled: true }
};

const operator = {
    _id: 'operator-1',
    name: 'منفذ الاختبار',
    role: 'operator',
    groupId: { _id: 'group-1', manualTaskRoutingEnabled: true }
};

describe('executor task routing service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('hides unassigned processing tasks from operators when manual routing is enabled', () => {
        const filter = taskOwnershipFilter(operator);

        expect(filter.$and).toHaveLength(2);
        expect(filter.$and[1].$or).toEqual([
            { status: 'accepted' },
            { status: 'processing', assignedExecutorId: 'operator-1' }
        ]);
    });

    test('does not allow an executor with an accepted task to accept another one', async () => {
        Transaction.exists.mockResolvedValue(true);

        const result = await acceptExecutorTask({ transactionId: 'tx-2', executor: operator });

        expect(result).toEqual({ ok: false, code: 'ACTIVE_TASK_EXISTS' });
        expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
        expect(acquireLock).toHaveBeenCalledWith('executor-active-task:operator-1', 10000, { retryCount: 1 });
        expect(releaseLock).toHaveBeenCalled();
    });

    test('accepts only a task directed to the current executor in manual routing mode', async () => {
        Transaction.exists.mockResolvedValue(false);
        Transaction.findOneAndUpdate.mockResolvedValue({ _id: 'tx-1' });

        const result = await acceptExecutorTask({ transactionId: 'tx-1', executor: operator });

        expect(result.ok).toBe(true);
        expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ _id: 'tx-1', status: 'processing' }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    operatorId: 'operator-1',
                    assignedExecutorId: 'operator-1'
                })
            }),
            { new: true }
        );
    });

    test('does not direct a task to an operator who already has an active task', async () => {
        Employee.findOne.mockResolvedValue(operator);
        Transaction.exists.mockResolvedValue(true);

        const result = await routeExecutorTask({
            transactionId: 'tx-3',
            manager,
            employeeId: 'operator-1'
        });

        expect(result).toEqual({ ok: false, code: 'ACTIVE_TASK_EXISTS' });
        expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
    });
});
