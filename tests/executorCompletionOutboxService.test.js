'use strict';

jest.mock('../models/ExecutorCompletionOutbox', () => ({
    updateOne: jest.fn().mockResolvedValue({}),
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({}),
    collection: { createIndex: jest.fn().mockResolvedValue('index') }
}));
jest.mock('../models/Transaction', () => ({ findById: jest.fn() }));
jest.mock('../models/Employee', () => ({ findById: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue() }));
jest.mock('../services/eventBus', () => ({ publishAsync: jest.fn().mockResolvedValue() }));
jest.mock('../utils/logger', () => ({ error: jest.fn() }));

const Outbox = require('../models/ExecutorCompletionOutbox');
const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const { logAction } = require('../services/auditService');
const eventBus = require('../services/eventBus');
const {
    enqueueCompletionEffects,
    processCompletionEffects,
    ensureExecutorCompletionOutboxIndexes
} = require('../services/executorCompletionOutboxService');

describe('Executor completion durable effects', () => {
    beforeEach(() => jest.clearAllMocks());

    test('enqueues once inside the caller transaction', async () => {
        const session = { id: 'session-1' };
        await enqueueCompletionEffects({
            tx: { _id: 'tx-1' }, emp: { _id: 'emp-1', name: 'Executor' },
            auditContext: { newData: { status: 'completed' } }, session
        });
        expect(Outbox.updateOne).toHaveBeenCalledWith(
            { transactionId: 'tx-1' }, expect.any(Object), { upsert: true, session }
        );
    });

    test('replays only audit and idempotent effects for an already completed transaction', async () => {
        const tx = { _id: 'tx-1', status: 'completed', customId: 'T-1', amount: 100, transferType: 'vodafone' };
        const emp = { _id: 'emp-1', name: 'Executor' };
        Transaction.findById.mockResolvedValue(tx);
        Employee.findById.mockResolvedValue(emp);
        const record = {
            _id: 'outbox-1', transactionId: tx._id, employeeId: emp._id,
            employeeName: emp.name, auditContext: { newData: { status: 'completed' } }
        };

        await processCompletionEffects(record);

        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            eventKey: 'executor-completion:tx-1', required: true
        }));
        expect(eventBus.publishAsync).toHaveBeenCalledWith('transfer:completed', { tx, emp });
        expect(Outbox.updateOne).toHaveBeenLastCalledWith(
            { _id: 'outbox-1', status: 'processing' },
            { $set: expect.objectContaining({ status: 'completed' }) }
        );
    });

    test('refuses to replay effects unless the financial transaction is completed', async () => {
        Transaction.findById.mockResolvedValue({ _id: 'tx-1', status: 'accepted' });
        Employee.findById.mockResolvedValue({ _id: 'emp-1' });
        await expect(processCompletionEffects({ transactionId: 'tx-1', employeeId: 'emp-1' }))
            .rejects.toThrow('COMPLETION_EFFECT_SOURCE_MISSING');
        expect(eventBus.publishAsync).not.toHaveBeenCalled();
    });

    test('creates the two production-critical indexes', async () => {
        await ensureExecutorCompletionOutboxIndexes();
        expect(Outbox.collection.createIndex).toHaveBeenCalledTimes(2);
    });
});
