'use strict';

jest.mock('../models/Employee');
jest.mock('../models/Transaction');
jest.mock('../services/lockService', () => ({
    acquireLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
    releaseLock: jest.fn().mockResolvedValue(true)
}));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { acquireLock, releaseLock } = require('../services/lockService');
const eventBus = require('../services/eventBus');
const {
    taskOwnershipFilter,
    acceptExecutorTask,
    routeExecutorTask,
    isTaskOwnedByExecutor,
    findOwnedAcceptedExecutorTask
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

    test('shows an operator only its own accepted or routed tasks when manual routing is enabled', () => {
        const filter = taskOwnershipFilter(operator);

        expect(filter.$and).toHaveLength(2);
        expect(filter.$and[1].$or).toEqual([
            {
                $or: [
                    { status: 'accepted', operatorId: 'operator-1' },
                    { status: 'accepted', assignedExecutorId: 'operator-1' }
                ]
            },
            {
                status: { $in: ['processing', 'pending'] },
                assignedExecutorId: 'operator-1'
            }
        ]);
    });

    test('recognizes a legacy task that stored the executor login name', () => {
        const legacyExecutor = { ...operator, webUsername: 'executor.demo' };
        expect(isTaskOwnedByExecutor({ operatorId: 'executor.demo' }, legacyExecutor)).toBe(true);
        expect(isTaskOwnedByExecutor({ assignedExecutorId: 'operator-2' }, legacyExecutor)).toBe(false);
    });

    test('resolves accepted task ownership consistently for exact and legacy records', async () => {
        const exactTask = {
            _id: 'tx-exact',
            status: 'accepted',
            operatorId: 'operator-1',
            executorGroupId: 'group-1'
        };
        Transaction.findOne.mockResolvedValueOnce(exactTask);

        await expect(findOwnedAcceptedExecutorTask({
            transactionId: 'tx-exact',
            executor: operator
        })).resolves.toBe(exactTask);

        const legacyTask = {
            _id: 'tx-legacy-complete',
            status: 'accepted',
            operatorId: 'old-login-value',
            executorGroupId: 'group-1',
            executorName: 'منفذ الاختبار'
        };
        Transaction.findOne.mockResolvedValueOnce(null);
        Transaction.findById.mockResolvedValueOnce(legacyTask);
        Employee.countDocuments.mockResolvedValueOnce(0);

        await expect(findOwnedAcceptedExecutorTask({
            transactionId: 'tx-legacy-complete',
            executor: operator
        })).resolves.toBe(legacyTask);
    });

    test('does not resolve an accepted task owned by another executor', async () => {
        const otherTask = {
            _id: 'tx-other',
            status: 'accepted',
            operatorId: 'operator-2',
            executorGroupId: 'group-1',
            executorName: 'منفذ آخر'
        };
        Transaction.findOne.mockResolvedValueOnce(null);
        Transaction.findById.mockResolvedValueOnce(otherTask);

        await expect(findOwnedAcceptedExecutorTask({
            transactionId: 'tx-other',
            executor: operator
        })).resolves.toBeNull();
    });

    test('shows unassigned tasks but hides another operator\'s accepted task when direct pulling is enabled', () => {
        const directOperator = {
            ...operator,
            groupId: { _id: 'group-1', manualTaskRoutingEnabled: false }
        };
        const filter = taskOwnershipFilter(directOperator);

        expect(filter.$and[1].$or).toContainEqual({
            status: { $in: ['processing', 'pending'] },
            $or: [
                { assignedExecutorId: { $exists: false } },
                { assignedExecutorId: null },
                { assignedExecutorId: 'operator-1' }
            ]
        });
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
            expect.objectContaining({
                _id: 'tx-1',
                status: { $in: ['processing', 'pending'] }
            }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    operatorId: 'operator-1',
                    assignedExecutorId: 'operator-1'
                })
            }),
            { new: true }
        );
        expect(eventBus.publish).toHaveBeenCalledWith(
            'executor:task-accepted',
            expect.objectContaining({ tx: { _id: 'tx-1' }, employee: operator })
        );
    });

    test('accepts a grouped pending task during a queue state transition', async () => {
        Transaction.exists.mockResolvedValue(false);
        Transaction.findOne.mockResolvedValue({
            _id: 'tx-pending',
            status: 'pending',
            executorGroupId: 'group-1'
        });
        Transaction.findOneAndUpdate.mockResolvedValue({ _id: 'tx-pending' });

        const result = await acceptExecutorTask({
            transactionId: 'tx-pending',
            executor: operator
        });

        expect(result.ok).toBe(true);
        expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: 'tx-pending',
                status: { $in: ['processing', 'pending'] }
            }),
            expect.any(Object),
            { new: true }
        );
    });

    test('accepts another task after the previous task is no longer active', async () => {
        Transaction.exists.mockResolvedValue(false);
        Transaction.findOneAndUpdate
            .mockResolvedValueOnce({ _id: 'tx-first' })
            .mockResolvedValueOnce({ _id: 'tx-second' });

        const first = await acceptExecutorTask({
            transactionId: 'tx-first',
            executor: operator
        });
        const second = await acceptExecutorTask({
            transactionId: 'tx-second',
            executor: operator
        });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(Transaction.findOneAndUpdate).toHaveBeenCalledTimes(2);
    });

    test('treats a repeated accept after the same executor already won as a replay', async () => {
        Transaction.findOne.mockResolvedValue({
            _id: 'tx-1',
            status: 'accepted',
            operatorId: 'operator-1',
            executorGroupId: 'group-1'
        });

        const result = await acceptExecutorTask({
            transactionId: 'tx-1',
            executor: operator
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            replayed: true
        }));
        expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('reports when an accepted task belongs to another executor', async () => {
        Transaction.exists.mockResolvedValue(false);
        Transaction.findOne.mockResolvedValue({
            _id: 'tx-1',
            status: 'accepted',
            operatorId: 'operator-2',
            executorName: 'منفذ آخر',
            executorGroupId: 'group-1'
        });
        Transaction.findOneAndUpdate.mockResolvedValue(null);

        const result = await acceptExecutorTask({
            transactionId: 'tx-1',
            executor: operator
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            code: 'TASK_TAKEN',
            acceptedByName: 'منفذ آخر'
        }));
    });

    test('treats a legacy row owned through assignedExecutorId as a replay', async () => {
        Transaction.findOne.mockResolvedValue({
            _id: 'tx-legacy',
            status: 'accepted',
            assignedExecutorId: 'operator-1',
            executorGroupId: 'group-1'
        });

        const result = await acceptExecutorTask({
            transactionId: 'tx-legacy',
            executor: operator
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            replayed: true
        }));
        expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
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

    test('directs a pending task during the queue state transition', async () => {
        Employee.findOne.mockResolvedValue(operator);
        Transaction.exists.mockResolvedValue(false);
        Transaction.findOneAndUpdate.mockResolvedValue({ _id: 'tx-pending' });

        const result = await routeExecutorTask({
            transactionId: 'tx-pending',
            manager,
            employeeId: 'operator-1'
        });

        expect(result.ok).toBe(true);
        expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: 'tx-pending',
                status: { $in: ['processing', 'pending'] }
            }),
            expect.any(Object),
            { new: true }
        );
    });
});
