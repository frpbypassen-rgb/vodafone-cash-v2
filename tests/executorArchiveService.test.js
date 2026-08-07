'use strict';

jest.mock('../models/ExecutorGroup', () => ({
    findById: jest.fn(),
    countDocuments: jest.fn(),
    findOneAndUpdate: jest.fn()
}));
jest.mock('../models/Employee', () => ({
    countDocuments: jest.fn(),
    updateMany: jest.fn()
}));
jest.mock('../models/Transaction', () => ({
    countDocuments: jest.fn()
}));
jest.mock('../models/Settings', () => ({
    updateMany: jest.fn()
}));
jest.mock('../utils/helpers', () => ({
    syncBotBalance: jest.fn()
}));

const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { syncBotBalance } = require('../utils/helpers');
const {
    archiveExecutorAccount,
    ExecutorArchiveError
} = require('../services/executorArchiveService');

describe('Executor archive service', () => {
    let group;
    let archivedGroup;

    beforeEach(() => {
        jest.clearAllMocks();
        group = {
            _id: 'executor-1',
            name: 'منفذ غير نشط',
            status: 'paused'
        };
        archivedGroup = {
            ...group,
            status: 'archived',
            archivedAt: new Date('2026-08-06T12:00:00.000Z'),
            archivedBy: 'المدير',
            archiveReason: 'الحساب غير نشط',
            archiveBalance: 1250,
            archiveTransactionCount: 14,
            archiveEmployeeCount: 3
        };

        ExecutorGroup.findById.mockResolvedValue(group);
        ExecutorGroup.countDocuments.mockResolvedValue(0);
        ExecutorGroup.findOneAndUpdate.mockResolvedValue(archivedGroup);
        Transaction.countDocuments
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(14);
        Employee.countDocuments.mockResolvedValue(3);
        Employee.updateMany.mockResolvedValue({ modifiedCount: 3 });
        Settings.updateMany.mockResolvedValue({ modifiedCount: 1 });
        syncBotBalance.mockResolvedValue(1250);
    });

    test('archives a paused executor while preserving its operation references', async () => {
        const result = await archiveExecutorAccount({
            executorId: group._id,
            archivedBy: 'المدير',
            reason: 'الحساب غير نشط'
        });

        expect(Transaction.countDocuments).toHaveBeenNthCalledWith(1, expect.objectContaining({
            $or: [
                { executorGroupId: group._id },
                { managerGroupId: group._id }
            ],
            status: { $in: ['pending', 'processing', 'accepted', 'deposit_pending'] }
        }));
        expect(Transaction.countDocuments).toHaveBeenNthCalledWith(2, {
            $or: [
                { executorGroupId: group._id },
                { managerGroupId: group._id }
            ]
        });
        expect(ExecutorGroup.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: group._id, status: { $ne: 'active' } },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: 'archived',
                    archiveBalance: 1250,
                    archiveTransactionCount: 14,
                    archiveEmployeeCount: 3
                })
            }),
            { new: true }
        );
        expect(Employee.updateMany).toHaveBeenCalledWith(
            { groupId: group._id },
            expect.objectContaining({
                $set: expect.objectContaining({ status: 'suspended' }),
                $unset: expect.objectContaining({ refreshToken: 1 })
            })
        );
        expect(Settings.updateMany).toHaveBeenNthCalledWith(
            1,
            {},
            { $pull: { autoRouteRules: { executorGroupId: group._id } } }
        );
        expect(Settings.updateMany).toHaveBeenNthCalledWith(
            2,
            { autoRouteBotId: group._id },
            { $set: { autoRouteBotId: null } }
        );
        expect(result).toEqual(expect.objectContaining({
            group: archivedGroup,
            archiveTransactionCount: 14,
            archiveEmployeeCount: 3,
            archiveBalance: 1250
        }));
        expect(Transaction.deleteMany).toBeUndefined();
    });

    test('rejects archiving an active executor', async () => {
        group.status = 'active';

        await expect(archiveExecutorAccount({ executorId: group._id }))
            .rejects.toMatchObject({ code: 'EXECUTOR_ACTIVE' });

        expect(ExecutorGroup.findOneAndUpdate).not.toHaveBeenCalled();
        expect(Employee.updateMany).not.toHaveBeenCalled();
    });

    test('rejects archiving while operations are still in flight', async () => {
        Transaction.countDocuments.mockReset().mockResolvedValue(2);

        await expect(archiveExecutorAccount({ executorId: group._id }))
            .rejects.toMatchObject({
                code: 'IN_FLIGHT_TRANSACTIONS',
                details: { inFlightCount: 2 }
            });

        expect(syncBotBalance).not.toHaveBeenCalled();
        expect(ExecutorGroup.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('rejects archiving a manager that still has linked executors', async () => {
        ExecutorGroup.countDocuments.mockResolvedValue(1);

        await expect(archiveExecutorAccount({ executorId: group._id }))
            .rejects.toBeInstanceOf(ExecutorArchiveError);
        await expect(archiveExecutorAccount({ executorId: group._id }))
            .rejects.toMatchObject({ code: 'LINKED_EXECUTORS' });

        expect(Transaction.countDocuments).not.toHaveBeenCalled();
        expect(ExecutorGroup.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('returns idempotently when the executor is already archived', async () => {
        ExecutorGroup.findById.mockResolvedValue(archivedGroup);

        const result = await archiveExecutorAccount({ executorId: group._id });

        expect(result).toEqual({ group: archivedGroup, alreadyArchived: true });
        expect(ExecutorGroup.countDocuments).not.toHaveBeenCalled();
        expect(Transaction.countDocuments).not.toHaveBeenCalled();
    });
});
