'use strict';

jest.mock('../models/Employee', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../models/MobilePushDevice', () => ({
    updateMany: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn()
}));
jest.mock('../models/PushNotificationOutbox', () => ({}));
jest.mock('../models/Transaction', () => ({ distinct: jest.fn() }));
jest.mock('../services/eventBus', () => ({ on: jest.fn(), publish: jest.fn() }));
jest.mock('../services/firebasePushService', () => ({
    getFirebasePushStatus: jest.fn(() => ({ enabled: true, configured: true })),
    isInvalidPushTokenError: jest.fn(() => false),
    sendPushToTokens: jest.fn()
}));

const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const MobilePushDevice = require('../models/MobilePushDevice');
const Transaction = require('../models/Transaction');
const {
    acknowledgeMobilePushTask,
    registerMobilePushDevice,
    resolveAudienceEmployeeIds
} = require('../services/executorPushNotificationService');

const queryResult = (value) => ({
    select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(value)
    })
});

describe('executor push notification audience', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Transaction.distinct.mockResolvedValue([]);
    });

    test('notifies only the manager when manual routing is enabled', async () => {
        Employee.find.mockReturnValue(queryResult([
            { _id: 'manager-1', role: 'manager' },
            { _id: 'operator-1', role: 'operator' }
        ]));
        ExecutorGroup.findById.mockReturnValue(queryResult({ manualTaskRoutingEnabled: true }));

        const ids = await resolveAudienceEmployeeIds(
            { audience: { type: 'task_group', groupId: 'group-1' } },
            { executorGroupId: 'group-1', status: 'processing' }
        );

        expect(ids).toEqual(['manager-1']);
    });

    test('notifies only the employee selected by the manager', async () => {
        Employee.find.mockReturnValue(queryResult([
            { _id: 'manager-1', role: 'manager' },
            { _id: 'operator-1', role: 'operator' },
            { _id: 'operator-2', role: 'operator' }
        ]));
        ExecutorGroup.findById.mockReturnValue(queryResult({ manualTaskRoutingEnabled: true }));

        const ids = await resolveAudienceEmployeeIds(
            { audience: { type: 'task_group', groupId: 'group-1' } },
            { executorGroupId: 'group-1', assignedExecutorId: 'operator-2', status: 'processing' }
        );

        expect(ids).toEqual(['operator-2']);
    });

    test('excludes an executor who already has an accepted operation', async () => {
        Employee.find.mockReturnValue(queryResult([
            { _id: 'manager-1', role: 'manager' },
            { _id: 'operator-1', role: 'operator' }
        ]));
        ExecutorGroup.findById.mockReturnValue(queryResult({ manualTaskRoutingEnabled: false }));
        Transaction.distinct.mockResolvedValue(['operator-1']);

        const ids = await resolveAudienceEmployeeIds(
            { audience: { type: 'task_group', groupId: 'group-1' } },
            { executorGroupId: 'group-1', status: 'processing' }
        );

        expect(ids).toEqual(['manager-1']);
    });

    test('registers an active executor device against its real employee group', async () => {
        Employee.findById.mockReturnValue(queryResult({
            _id: 'operator-1',
            groupId: 'group-1',
            role: 'operator',
            status: 'active'
        }));
        MobilePushDevice.updateMany.mockResolvedValue({ modifiedCount: 0 });
        MobilePushDevice.findOneAndUpdate.mockResolvedValue({
            _id: 'device-1',
            enabled: true,
            permissionStatus: 'authorized'
        });

        await registerMobilePushDevice({
            user: { accountType: 'executor', userId: 'operator-1' },
            payload: {
                installationId: 'install-1',
                token: 'valid-firebase-token-with-enough-characters',
                platform: 'android',
                permissionStatus: 'authorized'
            }
        });

        expect(MobilePushDevice.findOneAndUpdate).toHaveBeenCalledWith(
            { installationId: 'install-1' },
            expect.objectContaining({
                $set: expect.objectContaining({
                    accountId: 'operator-1',
                    executorGroupId: 'group-1',
                    executorRole: 'operator',
                    enabled: true
                })
            }),
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    });

    test('records task acknowledgement for the current installation only', async () => {
        MobilePushDevice.updateOne
            .mockResolvedValueOnce({ modifiedCount: 1 })
            .mockResolvedValueOnce({ modifiedCount: 1 });

        const acknowledged = await acknowledgeMobilePushTask({
            user: { accountType: 'executor', userId: 'operator-1' },
            installationId: 'install-1',
            transactionId: 'tx-1'
        });

        expect(acknowledged).toBe(true);
        expect(MobilePushDevice.updateOne).toHaveBeenLastCalledWith(
            {
                installationId: 'install-1',
                accountId: 'operator-1',
                accountType: 'executor'
            },
            expect.objectContaining({
                $push: {
                    acknowledgedTasks: expect.objectContaining({
                        $each: [expect.objectContaining({ transactionId: 'tx-1' })],
                        $slice: -100
                    })
                }
            })
        );
    });
});
