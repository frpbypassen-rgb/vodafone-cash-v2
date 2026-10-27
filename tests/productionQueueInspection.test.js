'use strict';
const {
    inspectRedisQueues,
    inspectActiveTransactions,
} = require('../scripts/inspectProductionQueues.cjs');

test('queue inspection uses only cardinality reads on fixed queue keys', async () => {
    const redis = {
        llen: jest.fn().mockResolvedValue(2),
        zcard: jest.fn().mockResolvedValue(3),
    };
    const result = await inspectRedisQueues(redis);
    expect(result['api-transfers-queue']).toMatchObject({
        active: 2,
        wait: 2,
        delayed: 3,
    });
    expect(redis.llen).toHaveBeenCalledWith('bull:api-transfers-queue:active');
    for (const [key] of [...redis.llen.mock.calls, ...redis.zcard.mock.calls])
        expect(key).toMatch(
            /^bull:[a-z-]+:(active|wait|delayed|prioritized|waiting-children)$/,
        );
});

test('transaction inspection is bounded, indexed and returns status counts without identities', async () => {
    const cursor = {
        hint: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        maxTimeMS: jest.fn().mockReturnThis(),
        toArray: jest
            .fn()
            .mockResolvedValue([
                { status: 'processing' },
                { status: 'accepted' },
            ]),
    };
    const collection = {
        listIndexes: () => ({
            toArray: async () => [
                {
                    name: 'status_1_updatedAt_-1',
                    key: { status: 1, updatedAt: -1 },
                },
            ],
        }),
        find: jest.fn().mockReturnValue(cursor),
    };
    const result = await inspectActiveTransactions(collection);
    expect(collection.find).toHaveBeenCalledWith(
        {
            status: {
                $in: ['pending', 'processing', 'accepted', 'deposit_pending'],
            },
        },
        { projection: { _id: 0, status: 1 } },
    );
    expect(cursor.limit).toHaveBeenCalledWith(101);
    expect(cursor.maxTimeMS).toHaveBeenCalledWith(1500);
    expect(result).toEqual({
        sampled: 2,
        truncated: false,
        statuses: { processing: 1, accepted: 1 },
    });
});

test('missing status index skips query instead of scanning production transactions', async () => {
    const collection = {
        listIndexes: () => ({ toArray: async () => [] }),
        find: jest.fn(),
    };
    expect(await inspectActiveTransactions(collection)).toEqual({
        skipped: 'NO_STATUS_INDEX',
    });
    expect(collection.find).not.toHaveBeenCalled();
});
