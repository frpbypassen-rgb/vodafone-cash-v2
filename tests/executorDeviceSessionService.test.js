'use strict';

jest.mock('../models/MobileDeviceSession', () => ({
    find: jest.fn(),
    updateMany: jest.fn()
}));

const MobileDeviceSession = require('../models/MobileDeviceSession');
const { enforceExecutorDeviceLimit } = require('../services/executorDeviceSessionService');

const chain = (result) => ({
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result)
});

describe('executor concurrent device limit', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        MobileDeviceSession.updateMany.mockResolvedValue({ modifiedCount: 0 });
    });

    test('keeps the newest session and revokes older ones when the limit is 1', async () => {
        MobileDeviceSession.find.mockReturnValue(chain([
            { _id: 'keep', sessionId: 'new-login' },
            { _id: 'old-1', sessionId: 'previous' },
            { _id: 'old-2', sessionId: 'oldest' }
        ]));

        const result = await enforceExecutorDeviceLimit({
            account: { _id: 'emp-1' },
            group: { maxConcurrentDevices: 1 },
            keepSessionId: 'new-login'
        });

        expect(result).toEqual({ revoked: 2, limit: 1 });
        expect(MobileDeviceSession.updateMany).toHaveBeenCalledWith(
            { _id: { $in: ['old-1', 'old-2'] } },
            expect.objectContaining({
                $set: expect.objectContaining({
                    active: false,
                    revokeReason: 'device_limit_exceeded'
                })
            })
        );
    });

    test('allows the configured number of simultaneous sessions', async () => {
        MobileDeviceSession.find.mockReturnValue(chain([
            { _id: 'a', sessionId: 's1' },
            { _id: 'b', sessionId: 's2' },
            { _id: 'c', sessionId: 's3' },
            { _id: 'd', sessionId: 's4' },
            { _id: 'e', sessionId: 's5' },
            { _id: 'f', sessionId: 's6' }
        ]));

        const result = await enforceExecutorDeviceLimit({
            account: {
                _id: 'emp-1',
                executionPolicyOverride: { maxConcurrentDevices: 5 }
            },
            group: { maxConcurrentDevices: 1 },
            keepSessionId: 's1'
        });

        expect(result.limit).toBe(5);
        expect(result.revoked).toBe(1);
        expect(MobileDeviceSession.updateMany).toHaveBeenCalledWith(
            { _id: { $in: ['f'] } },
            expect.any(Object)
        );
    });

    test('does not revoke sessions when still within the limit', async () => {
        MobileDeviceSession.find.mockReturnValue(chain([
            { _id: 'a', sessionId: 's1' },
            { _id: 'b', sessionId: 's2' }
        ]));

        const result = await enforceExecutorDeviceLimit({
            account: { _id: 'emp-1' },
            group: { maxConcurrentDevices: 5 },
            keepSessionId: 's1'
        });

        expect(result).toEqual({ revoked: 0, limit: 5 });
        expect(MobileDeviceSession.updateMany).not.toHaveBeenCalled();
    });
});
