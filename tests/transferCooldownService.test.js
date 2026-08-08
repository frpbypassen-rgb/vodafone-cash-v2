'use strict';

jest.mock('../models/Transaction', () => ({ findOne: jest.fn() }));
jest.mock('../services/lockService', () => ({
    acquireLock: jest.fn(),
    releaseLock: jest.fn()
}));

const Transaction = require('../models/Transaction');
const { acquireLock, releaseLock } = require('../services/lockService');
const {
    BLOCKING_STATUSES,
    TransferCooldownError,
    acquireTransferCooldown,
    buildRequestOwnerKey,
    normalizeTransferRecipient,
    releaseTransferCooldown
} = require('../services/transferCooldownService');

const queryResult = (value) => ({
    sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(value)
    })
});

describe('transferCooldownService', () => {
    const now = Date.UTC(2026, 7, 9, 12, 0, 0);
    const lock = { release: jest.fn().mockResolvedValue(undefined) };
    const baseInput = {
        ownerModel: 'User',
        ownerId: 'user-100',
        serviceKey: 'vodafone',
        recipient: '01108172258',
        amount: 100
    };

    beforeEach(() => {
        jest.clearAllMocks();
        acquireLock.mockResolvedValue(lock);
        Transaction.findOne.mockImplementation(() => queryResult(null));
    });

    test('normalizes Egyptian mobile aliases to the same recipient identity', () => {
        expect(normalizeTransferRecipient('+201108172258')).toBe('01108172258');
        expect(normalizeTransferRecipient('00201108172258')).toBe('01108172258');
        expect(normalizeTransferRecipient('٠١١٠٨١٧٢٢٥٨')).toBe('01108172258');
    });

    test('blocks the same recipient and amount for five minutes', async () => {
        Transaction.findOne.mockImplementation(() => queryResult({
            amount: 100,
            createdAt: new Date(now - (4 * 60 * 1000)),
            status: 'completed'
        }));

        await expect(acquireTransferCooldown({ ...baseInput, now })).rejects.toMatchObject({
            name: 'TransferCooldownError',
            code: 'TRANSFER_COOLDOWN_ACTIVE',
            cooldownType: 'same_amount',
            retryAfterSeconds: 60
        });

        expect(Transaction.findOne).toHaveBeenCalledWith(expect.objectContaining({
            requestOwnerKey: 'wallet:User:user-100',
            canonicalServiceKey: 'vodafone',
            canonicalRecipient: '01108172258',
            amount: 100,
            status: { $in: BLOCKING_STATUSES }
        }));
        expect(releaseLock).toHaveBeenCalledWith(lock);
    });

    test('blocks a different amount to the same recipient for two minutes', async () => {
        Transaction.findOne
            .mockImplementationOnce(() => queryResult(null))
            .mockImplementationOnce(() => queryResult({
                amount: 125,
                createdAt: new Date(now - 60 * 1000),
                status: 'pending'
            }));

        await expect(acquireTransferCooldown({ ...baseInput, now })).rejects.toMatchObject({
            name: 'TransferCooldownError',
            code: 'TRANSFER_COOLDOWN_ACTIVE',
            cooldownType: 'different_amount',
            retryAfterSeconds: 60
        });
    });

    test('allows the transfer after the matching time window and returns persisted guard fields', async () => {
        Transaction.findOne
            .mockImplementationOnce(() => queryResult({
                amount: 100,
                createdAt: new Date(now - (5 * 60 * 1000)),
                status: 'completed'
            }))
            .mockImplementationOnce(() => queryResult({
                amount: 125,
                createdAt: new Date(now - (2 * 60 * 1000)),
                status: 'completed'
            }));

        const result = await acquireTransferCooldown({ ...baseInput, now });

        expect(result.guardFields).toEqual({
            requestOwnerKey: 'wallet:User:user-100',
            canonicalServiceKey: 'vodafone',
            canonicalRecipient: '01108172258'
        });
        expect(result.lock).toBe(lock);

        await releaseTransferCooldown(result.lock);
        expect(releaseLock).toHaveBeenLastCalledWith(lock);
    });

    test('keeps cooldown scope isolated per source wallet', () => {
        expect(buildRequestOwnerKey({ modelName: 'User', id: 'agent-1' }))
            .not.toBe(buildRequestOwnerKey({ modelName: 'ClientCompany', id: 'agent-1' }));
    });

    test('uses a typed error when the lock cannot be acquired', async () => {
        acquireLock.mockRejectedValueOnce(new Error('LOCK_ACQUISITION_TIMEOUT'));

        await expect(acquireTransferCooldown({ ...baseInput, now })).rejects.toBeInstanceOf(TransferCooldownError);
    });
});
