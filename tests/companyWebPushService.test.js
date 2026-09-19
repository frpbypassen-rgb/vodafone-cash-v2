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
jest.mock('mongoose', () => ({
    connection: { readyState: 1 }
}));

const WebPushSubscription = require('../models/WebPushSubscription');
const webpush = require('web-push');
const service = require('../services/companyWebPushService');

describe('company web push service', () => {
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

    test('stores a company browser subscription without touching executor account types', async () => {
        WebPushSubscription.findOneAndUpdate.mockResolvedValue({ _id: 'subscription-1' });
        const subscription = {
            endpoint: 'https://push.example/company',
            expirationTime: null,
            keys: { p256dh: 'key-one', auth: 'key-two' }
        };

        await service.upsertCompanySubscription({ userId: 'employee-1', accountType: 'company', subscription });

        expect(WebPushSubscription.findOneAndUpdate).toHaveBeenCalledWith(
            { endpoint: subscription.endpoint },
            expect.objectContaining({
                $set: expect.objectContaining({
                    userId: 'employee-1',
                    accountType: 'company',
                    active: true,
                    subscription
                })
            }),
            expect.objectContaining({ upsert: true, new: true })
        );
    });

    test('sends only to company account subscriptions', async () => {
        WebPushSubscription.find.mockReturnValue({
            lean: jest.fn().mockResolvedValue([{
                _id: 'sub-1',
                subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'one', auth: 'two' } }
            }])
        });
        WebPushSubscription.updateOne.mockResolvedValue({ modifiedCount: 1 });
        webpush.sendNotification.mockResolvedValue({ statusCode: 201 });

        const result = await service.sendCompanyWebPush({
            userIds: ['employee-1', 'employee-1'],
            title: 'تم إتمام التحويل',
            body: 'اكتملت العملية',
            category: 'transfer_complete',
            data: { url: '/client/transactions' }
        });

        expect(WebPushSubscription.find).toHaveBeenCalledWith({
            accountType: { $in: ['company', 'client_company'] },
            userId: { $in: ['employee-1'] },
            active: true
        });
        expect(webpush.sendNotification).toHaveBeenCalled();
        expect(result).toMatchObject({ configured: true, attempted: 1, sent: 1, failed: 0 });
    });
});
