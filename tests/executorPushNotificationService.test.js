'use strict';

jest.mock('../models/Employee', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../models/MobileNotificationInbox', () => ({
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    findOneAndUpdate: jest.fn().mockResolvedValue({})
}));
jest.mock('../models/MobilePushDevice', () => ({
    updateMany: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn()
}));
jest.mock('../models/PushNotificationOutbox', () => ({ updateOne: jest.fn() }));
jest.mock('../models/Transaction', () => ({ distinct: jest.fn(), findById: jest.fn() }));
jest.mock('../services/eventBus', () => ({ on: jest.fn(), publish: jest.fn() }));
jest.mock('../services/firebasePushService', () => ({
    getFirebasePushStatus: jest.fn(() => ({ enabled: true, configured: true })),
    isInvalidPushTokenError: jest.fn(() => false),
    sendPushToTokens: jest.fn()
}));

const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const MobilePushDevice = require('../models/MobilePushDevice');
const PushNotificationOutbox = require('../models/PushNotificationOutbox');
const Transaction = require('../models/Transaction');
const { sendPushToTokens } = require('../services/firebasePushService');
const {
    acknowledgeMobilePushTask,
    processOutboxItem,
    registerMobilePushDevice,
    resolveAudienceEmployeeIds,
    snoozeMobilePushTask,
    updateMobilePushPreferences
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

    test('targets selected roles and explicitly included employees', async () => {
        Employee.find.mockReturnValue(queryResult([
            { _id: 'manager-1', role: 'manager' },
            { _id: 'accountant-1', role: 'accountant' }
        ]));

        const ids = await resolveAudienceEmployeeIds(
            {
                audience: {
                    type: 'group_roles',
                    groupId: 'group-1',
                    roles: ['manager', 'accountant'],
                    includeEmployeeIds: ['operator-1']
                }
            },
            { executorGroupId: 'group-1' }
        );

        expect(ids).toEqual(['manager-1', 'accountant-1', 'operator-1']);
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

    test('keeps task and urgent notifications mandatory when preferences change', async () => {
        MobilePushDevice.findOneAndUpdate.mockReturnValue(queryResult({
            notificationPreferences: {
                tasks: true,
                urgent: true,
                reminders: false,
                support: false
            }
        }));

        const preferences = await updateMobilePushPreferences({
            user: { accountType: 'executor', userId: 'operator-1' },
            installationId: 'install-1',
            preferences: {
                tasks: false,
                urgent: false,
                reminders: false,
                support: false
            }
        });

        expect(preferences.tasks).toBe(true);
        expect(preferences.urgent).toBe(true);
        expect(preferences.reminders).toBe(false);
        expect(preferences.support).toBe(false);
        expect(MobilePushDevice.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ installationId: 'install-1', accountId: 'operator-1' }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    'notificationPreferences.tasks': true,
                    'notificationPreferences.urgent': true,
                    'notificationPreferences.reminders': false
                })
            }),
            { new: true }
        );
    });

    test('snoozes a task for five minutes on the current installation', async () => {
        MobilePushDevice.updateOne
            .mockResolvedValueOnce({ modifiedCount: 1 })
            .mockResolvedValueOnce({ modifiedCount: 1 });

        const result = await snoozeMobilePushTask({
            user: { accountType: 'executor', userId: 'operator-1' },
            installationId: 'install-1',
            transactionId: 'tx-2',
            minutes: 5
        });

        expect(result.updated).toBe(true);
        expect(new Date(result.mutedUntil).getTime()).toBeGreaterThan(Date.now());
        expect(MobilePushDevice.updateOne).toHaveBeenLastCalledWith(
            expect.objectContaining({ installationId: 'install-1', accountId: 'operator-1' }),
            expect.objectContaining({
                $push: {
                    snoozedTasks: expect.objectContaining({
                        $each: [expect.objectContaining({ transactionId: 'tx-2' })],
                        $slice: -100
                    })
                }
            })
        );
    });

    test('delivers a support notification without trying to schedule a task reminder', async () => {
        MobilePushDevice.find.mockReturnValue(queryResult([
            {
                _id: 'device-1',
                token: 'token-1',
                accountId: 'operator-1',
                notificationPreferences: { support: true }
            }
        ]));
        MobilePushDevice.updateOne.mockResolvedValue({ modifiedCount: 1 });
        PushNotificationOutbox.updateOne.mockResolvedValue({ modifiedCount: 1 });
        sendPushToTokens.mockResolvedValue({
            successCount: 1,
            failureCount: 0,
            responses: [{ token: 'token-1', success: true }]
        });

        const result = await processOutboxItem({
            _id: 'outbox-1',
            eventKey: 'support-1',
            transactionId: null,
            category: 'executor_support_reply',
            audience: { type: 'employee_ids', employeeIds: ['operator-1'] },
            title: 'رد جديد',
            body: 'تم الرد على طلب الدعم.',
            data: { ticketId: 'ticket-1' },
            visible: true,
            reminderSequence: 0,
            channelId: 'executor_support_v1',
            sound: 'ahram_support',
            priority: 'high',
            route: 'support',
            collapseKey: 'support-ticket-1'
        });

        expect(result.status).toBe('sent');
        expect(sendPushToTokens).toHaveBeenCalledWith(expect.objectContaining({
            androidDataOnly: true,
            channelId: 'executor_support_v1',
            sound: 'ahram_support'
        }));
    });
});
