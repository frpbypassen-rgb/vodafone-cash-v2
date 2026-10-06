'use strict';

const ExecutorCompletionOutbox = require('../models/ExecutorCompletionOutbox');
const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const { logAction } = require('./auditService');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');

const STALE_LOCK_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
let workerTimer = null;

const compactError = (error) => String(error?.code || error?.message || 'COMPLETION_EFFECT_FAILED').slice(0, 500);

const ensureExecutorCompletionOutboxIndexes = async () => {
    await Promise.all([
        ExecutorCompletionOutbox.collection.createIndex(
            { transactionId: 1 },
            { name: 'transactionId_1', unique: true }
        ),
        ExecutorCompletionOutbox.collection.createIndex(
            { status: 1, availableAt: 1, createdAt: 1 },
            { name: 'completionOutbox_status_available_created' }
        )
    ]);
};

const enqueueCompletionEffects = async ({ tx, emp, auditContext, session }) => {
    await ExecutorCompletionOutbox.updateOne(
        { transactionId: tx._id },
        {
            $setOnInsert: {
                transactionId: tx._id,
                employeeId: emp._id,
                employeeName: emp.name,
                auditContext,
                status: 'pending',
                availableAt: new Date()
            }
        },
        { upsert: true, ...(session ? { session } : {}) }
    );
};

const claimNext = () => ExecutorCompletionOutbox.findOneAndUpdate(
    {
        $or: [
            { status: 'pending', availableAt: { $lte: new Date() } },
            { status: 'processing', lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } }
        ]
    },
    { $set: { status: 'processing', lockedAt: new Date() }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
);

const processCompletionEffects = async (record) => {
    const [tx, emp] = await Promise.all([
        Transaction.findById(record.transactionId),
        Employee.findById(record.employeeId)
    ]);
    if (!tx || tx.status !== 'completed' || !emp) throw new Error('COMPLETION_EFFECT_SOURCE_MISSING');
    const audit = record.auditContext || {};
    await logAction({
        action: 'TRANSFER_COMPLETED',
        eventKey: `executor-completion:${tx._id}`,
        required: true,
        performedById: emp._id,
        performedByModel: 'Employee',
        performedByName: record.employeeName || emp.name,
        targetId: tx._id,
        targetModel: 'Transaction',
        oldData: { status: 'accepted' },
        newData: audit.newData,
        metadata: { customId: tx.customId, amount: tx.amount, transferType: tx.transferType, request: audit.request }
    });
    await eventBus.publishAsync('transfer:completed', { tx, emp });
    await ExecutorCompletionOutbox.updateOne(
        { _id: record._id, status: 'processing' },
        { $set: { status: 'completed', completedAt: new Date(), lockedAt: null, lastError: '' } }
    );
};

const runCompletionOutboxTick = async () => {
    const record = await claimNext();
    if (!record) return false;
    try {
        await processCompletionEffects(record);
    } catch (error) {
        const delayMs = Math.min(60000, 1000 * (2 ** Math.min(record.attempts || 1, 6)));
        await ExecutorCompletionOutbox.updateOne(
            { _id: record._id, status: 'processing' },
            { $set: { status: 'pending', lockedAt: null, availableAt: new Date(Date.now() + delayMs), lastError: compactError(error) } }
        );
        throw error;
    }
    return true;
};

const startExecutorCompletionOutboxWorker = async () => {
    await ExecutorCompletionOutbox.updateMany(
        { status: 'processing', lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
        { $set: { status: 'pending', lockedAt: null, availableAt: new Date() } }
    );
    if (!workerTimer) {
        workerTimer = setInterval(() => {
            runCompletionOutboxTick().catch((error) => logger.error('Executor completion outbox tick failed', { error: compactError(error) }));
        }, POLL_INTERVAL_MS);
        workerTimer.unref?.();
    }
    await runCompletionOutboxTick().catch((error) => logger.error('Initial executor completion outbox tick failed', { error: compactError(error) }));
};

module.exports = {
    ensureExecutorCompletionOutboxIndexes,
    enqueueCompletionEffects,
    processCompletionEffects,
    runCompletionOutboxTick,
    startExecutorCompletionOutboxWorker
};
