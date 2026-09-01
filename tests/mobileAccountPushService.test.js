'use strict';

jest.mock('../models/MobilePushDevice', () => ({
    find: jest.fn(),
    updateOne: jest.fn()
}));
jest.mock('../services/firebasePushService', () => ({
    sendPushToTokens: jest.fn(),
    isInvalidPushTokenError: jest.fn(() => false)
}));

const MobilePushDevice = require('../models/MobilePushDevice');
const { sendPushToTokens } = require('../services/firebasePushService');
const { deliverMobileAccountPush } = require('../services/mobileAccountPushService');

describe('mobile account push service', () => {
    beforeEach(() => jest.clearAllMocks());

    test('delivers a data-only notification to active devices of the requested account only', async () => {
        MobilePushDevice.find.mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue([{ _id: 'device-1', token: 'token-1' }])
            })
        });
        MobilePushDevice.updateOne.mockResolvedValue({ modifiedCount: 1 });
        sendPushToTokens.mockResolvedValue({
            successCount: 1,
            failureCount: 0,
            responses: [{ token: 'token-1', success: true }]
        });

        const result = await deliverMobileAccountPush({
            targets: [{ accountType: 'client_company', accountId: 'employee-1' }],
            title: 'إيداع رصيد',
            body: 'تمت إضافة رصيد إلى الحساب.',
            referenceId: 'TX-1'
        });

        expect(MobilePushDevice.find).toHaveBeenCalledWith({
            $or: [{ accountType: 'client_company', accountId: 'employee-1' }],
            enabled: true,
            permissionStatus: { $in: ['authorized', 'provisional'] }
        });
        expect(sendPushToTokens).toHaveBeenCalledWith(expect.objectContaining({
            tokens: ['token-1'],
            androidDataOnly: true,
            channelId: 'client_general_v1',
            data: expect.objectContaining({ category: 'client_general', route: 'notifications' })
        }));
        expect(result).toEqual({ attempted: 1, sent: 1, failed: 0 });
    });
});
