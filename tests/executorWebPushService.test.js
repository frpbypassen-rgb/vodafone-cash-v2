'use strict';

jest.mock('../models/WebPushSubscription', () => ({
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn(),
    countDocuments: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    updateOne: jest.fn()
}));
jest.mock('web-push', () => ({
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn()
}));

const WebPushSubscription = require('../models/WebPushSubscription');
const webpush = require('web-push');
const service = require('../services/executorWebPushService');

describe('executor web push service', () => {
    const originalEnvironment = { ...process.env };

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.WEB_PUSH_PUBLIC_KEY = 'public-key';
        process.env.WEB_PUSH_PRIVATE_KEY = 'private-key';
        process.env.WEB_PUSH_SUBJECT = 'mailto:test@ahrampay.com';
    });

    afterAll(() => {
        process.env = originalEnvironment;
    });

    test('normalizes and stores an executor browser subscription', async () => {
        WebPushSubscription.findOneAndUpdate.mockResolvedValue({ _id: 'subscription-1' });
        const subscription = {
            endpoint: 'https://push.example/subscription',
            expirationTime: null,
            keys: { p256dh: 'key-one', auth: 'key-two' }
        };

        await service.upsertExecutorSubscription({ employeeId: 'employee-1', subscription });

        expect(WebPushSubscription.findOneAndUpdate).toHaveBeenCalledWith(
            { endpoint: subscription.endpoint },
            expect.objectContaining({
                $set: expect.objectContaining({
                    userId: 'employee-1',
                    accountType: 'executor',
                    active: true,
                    subscription
                })
            }),
            expect.objectContaining({ upsert: true, new: true })
        );
    });

    test('rejects incomplete browser subscription data', () => {
        expect(() => service.normalizeSubscription({ endpoint: 'https://push.example' }))
            .toThrow('INVALID_WEB_PUSH_SUBSCRIPTION');
    });

    test('sends only to subscriptions belonging to the selected employees', async () => {
        WebPushSubscription.find.mockReturnValue({
            lean: jest.fn().mockResolvedValue([{ _id: 'sub-1', subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'one', auth: 'two' } } }])
        });
        WebPushSubscription.updateOne.mockResolvedValue({ modifiedCount: 1 });
        webpush.sendNotification.mockResolvedValue({ statusCode: 201 });

        const result = await service.sendExecutorWebPush({
            employeeIds: ['employee-1', 'employee-1'],
            title: 'عملية جديدة',
            body: 'محافظ كاش | 011 | 100',
            category: 'executor_task_new',
            data: { url: '/executor-portal/dashboard' }
        });

        expect(WebPushSubscription.find).toHaveBeenCalledWith({
            accountType: 'executor',
            userId: { $in: ['employee-1'] },
            active: true
        });
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ configured: true, attempted: 1, sent: 1, failed: 0 });
    });
});
