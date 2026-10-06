'use strict';

const {
    inspectTrustedDeviceIndexes,
    inspectCompletionOutboxIndexes,
    inspectExecutorReadiness
} = require('../services/executorReadinessService');

describe('Read-only executor deployment readiness', () => {
    test.each([
        [[], false],
        [[{ key: { expiresAt: 1 } }], false],
        [[{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }], true],
        [[{ key: { expiresAt: 1 }, expireAfterSeconds: 60 }], false],
        [[{ key: { expiresAt: 1 }, expireAfterSeconds: 0, partialFilterExpression: { role: 'admin' } }], false],
        [[{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }, { key: { expiresAt: 1 } }], false],
        [[{ key: { expiresAt: 1, userId: 1 }, expireAfterSeconds: 0 }], false]
    ])('evaluates the live TTL index definition: %p', (indexes, passed) => {
        expect(inspectTrustedDeviceIndexes(indexes).passed).toBe(passed);
    });

    test('requires a unique transaction key and a pending-work index for completion effects', () => {
        expect(inspectCompletionOutboxIndexes([
            { key: { transactionId: 1 }, unique: true },
            { key: { status: 1, availableAt: 1, createdAt: 1 } }
        ]).passed).toBe(true);
        expect(inspectCompletionOutboxIndexes([{ key: { transactionId: 1 } }]).passed).toBe(false);
    });

    const fixture = (hello = { setName: 'test-rs' }) => {
        const session = {
            startTransaction: jest.fn(), inTransaction: jest.fn(() => true),
            abortTransaction: jest.fn().mockResolvedValue(), endSession: jest.fn().mockResolvedValue()
        };
        const transactions = { findOne: jest.fn().mockResolvedValue(null) };
        const devices = { indexes: jest.fn().mockResolvedValue([{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }]) };
        const outbox = { indexes: jest.fn().mockResolvedValue([
            { key: { transactionId: 1 }, unique: true },
            { key: { status: 1, availableAt: 1, createdAt: 1 } }
        ]) };
        const db = {
            admin: () => ({ command: jest.fn().mockResolvedValue(hello) }),
            collection: jest.fn((name) => {
                if (name === 'transactions') return transactions;
                if (name === 'trusteddevices') return devices;
                return outbox;
            })
        };
        const connection = { db, startSession: jest.fn().mockResolvedValue(session) };
        return { connection, session, transactions, devices, outbox };
    };

    test.each([{ setName: 'test-rs' }, { msg: 'isdbgrid' }])('probes transactional reads and aborts without writing: %p', async (hello) => {
        const { connection, session, transactions } = fixture(hello);
        const report = await inspectExecutorReadiness(connection);
        expect(report.ready).toBe(true);
        expect(transactions.findOne).toHaveBeenCalledWith({}, { projection: { _id: 1 }, session });
        expect(session.abortTransaction).toHaveBeenCalledTimes(1);
        expect(session.endSession).toHaveBeenCalledTimes(1);
        expect(connection.db.collection.mock.calls.map(([name]) => name)).toEqual([
            'transactions', 'trusteddevices', 'executorcompletionoutboxes'
        ]);
    });

    test('rejects a standalone server before attempting a transaction', async () => {
        const { connection } = fixture({});
        expect((await inspectExecutorReadiness(connection)).ready).toBe(false);
        expect(connection.startSession).not.toHaveBeenCalled();
    });

    test('a missing device collection does not report a valid TTL index', async () => {
        const { connection, devices } = fixture();
        devices.indexes.mockRejectedValueOnce(Object.assign(new Error('NamespaceNotFound'), { code: 26 }));
        const report = await inspectExecutorReadiness(connection);
        expect(report.ready).toBe(false);
        expect(report.checks.find((check) => check.code === 'TRUSTED_DEVICE_TTL').reason)
            .toBe('TTL_INDEX_MISSING_OR_CONFLICTING');
    });

    test('always aborts and closes its session when the read fails', async () => {
        const { connection, session, transactions } = fixture();
        transactions.findOne.mockRejectedValueOnce(new Error('read failed'));
        await expect(inspectExecutorReadiness(connection)).rejects.toThrow('read failed');
        expect(session.abortTransaction).toHaveBeenCalledTimes(1);
        expect(session.endSession).toHaveBeenCalledTimes(1);
    });
});
