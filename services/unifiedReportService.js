'use strict';

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const UnifiedReportEntry = require('../models/UnifiedReportEntry');
const UnifiedReportState = require('../models/UnifiedReportState');
const logger = require('../utils/logger');

const REPORT_STATE_KEY = 'transactions-v1';
const REPORT_SNAPSHOT_VERSION = 1;
const DEFAULT_BATCH_SIZE = 250;
const OMITTED_SNAPSHOT_FIELDS = new Set([
    'idempotencyKey',
    'idempotencyFingerprint',
    'idempotencyResponse',
    'editIdempotencyKey',
    'editIdempotencyFingerprint',
    'editIdempotencyResponse',
    'zaynpayIdempotencyKey',
    'zaynpayIdempotencyFingerprint',
    'zaynpayIdempotencyResponse'
]);

let changeStream = null;
let backfillPromise = null;
let retryTimer = null;

const plainTransaction = (transaction) => {
    if (!transaction) return null;
    if (typeof transaction.toObject === 'function') {
        return transaction.toObject({ depopulate: true, getters: false, virtuals: false });
    }
    return { ...transaction };
};

const buildReportSnapshot = (transaction) => {
    const source = plainTransaction(transaction);
    if (!source?._id || !source.customId) throw new Error('INVALID_REPORT_TRANSACTION');

    const snapshot = {};
    Object.entries(source).forEach(([key, value]) => {
        if (!OMITTED_SNAPSHOT_FIELDS.has(key)) snapshot[key] = value;
    });
    return snapshot;
};

const buildReportEntry = (transaction) => {
    const snapshot = buildReportSnapshot(transaction);
    const createdAt = new Date(snapshot.createdAt || Date.now());
    const sourceUpdatedAt = new Date(snapshot.updatedAt || snapshot.createdAt || Date.now());
    return {
        transactionId: snapshot._id,
        customId: snapshot.customId,
        tenantId: snapshot.tenantId || null,
        userId: snapshot.userId || null,
        companyId: snapshot.companyId || null,
        subAccountId: snapshot.subAccountId || null,
        isSubAccountTx: snapshot.isSubAccountTx === true,
        companyName: snapshot.companyName || null,
        employeeName: snapshot.employeeName || null,
        executorGroupId: snapshot.executorGroupId || null,
        managerGroupId: snapshot.managerGroupId || null,
        operatorId: snapshot.operatorId || null,
        executorName: snapshot.executorName || null,
        status: snapshot.status,
        transferType: snapshot.transferType || null,
        createdAt,
        sourceUpdatedAt,
        indexedAt: new Date(),
        snapshotVersion: REPORT_SNAPSHOT_VERSION,
        snapshot
    };
};

const isDatabaseReady = () => mongoose.connection.readyState === 1;

const syncReportTransactions = async (transactions, { session = null } = {}) => {
    const rows = (transactions || []).filter(Boolean).map(buildReportEntry);
    if (!rows.length || !isDatabaseReady()) return 0;

    const operations = rows.map((entry) => ({
        updateOne: {
            filter: { transactionId: entry.transactionId },
            update: { $set: entry },
            upsert: true
        }
    }));
    await UnifiedReportEntry.bulkWrite(operations, {
        ordered: false,
        ...(session ? { session } : {})
    });
    await UnifiedReportState.updateOne(
        { key: REPORT_STATE_KEY },
        { $set: { lastSyncedAt: new Date(), lastError: null } },
        { upsert: true, ...(session ? { session } : {}) }
    );
    return rows.length;
};

const syncReportTransaction = async (transaction, options) => (
    syncReportTransactions(transaction ? [transaction] : [], options)
);

const querySourceTransactions = async (query, { select = null, sort = null } = {}) => {
    let databaseQuery = Transaction.find(query);
    if (select && typeof databaseQuery.select === 'function') databaseQuery = databaseQuery.select(select);
    if (sort && typeof databaseQuery.sort === 'function') databaseQuery = databaseQuery.sort(sort);
    return typeof databaseQuery.lean === 'function' ? databaseQuery.lean() : databaseQuery;
};

/**
 * Single report data gateway. Transaction remains the financial source of
 * truth while every result is mirrored into the unified read model. Existing
 * report consumers therefore keep identical behavior during backfill.
 */
const findReportTransactions = async (query, options = {}) => {
    const transactions = await querySourceTransactions(query, options);
    const selectedFields = String(options.select || '').trim().split(/\s+/).filter(Boolean);
    const hasPartialProjection = selectedFields.some((field) => !field.startsWith('+'));
    if (isDatabaseReady() && transactions.length && !hasPartialProjection) {
        await syncReportTransactions(transactions).catch((error) => {
            logger.error('Unified report read-through sync failed', { error: error.message });
        });
    }
    return transactions;
};

const backfillUnifiedReports = async ({ batchSize = DEFAULT_BATCH_SIZE } = {}) => {
    if (!isDatabaseReady()) throw new Error('DATABASE_NOT_READY');
    if (backfillPromise) return backfillPromise;

    backfillPromise = (async () => {
        const startedAt = new Date();
        await UnifiedReportState.updateOne(
            { key: REPORT_STATE_KEY },
            {
                $set: {
                    status: 'running',
                    startedAt,
                    completedAt: null,
                    scannedCount: 0,
                    indexedCount: 0,
                    lastError: null
                }
            },
            { upsert: true }
        );

        let scannedCount = 0;
        let indexedCount = 0;
        let batch = [];
        const cursor = Transaction.find({})
            .select('+executorExecutionNumber +executorSenderEntries')
            .sort({ _id: 1 })
            .lean()
            .cursor();

        for await (const transaction of cursor) {
            batch.push(transaction);
            scannedCount += 1;
            if (batch.length >= batchSize) {
                indexedCount += await syncReportTransactions(batch);
                batch = [];
                await UnifiedReportState.updateOne(
                    { key: REPORT_STATE_KEY },
                    { $set: { scannedCount, indexedCount, lastSyncedAt: new Date() } }
                );
            }
        }
        if (batch.length) indexedCount += await syncReportTransactions(batch);

        await UnifiedReportState.updateOne(
            { key: REPORT_STATE_KEY },
            {
                $set: {
                    status: 'ready',
                    scannedCount,
                    indexedCount,
                    completedAt: new Date(),
                    lastSyncedAt: new Date(),
                    lastError: null
                }
            }
        );
        logger.info('Unified report backfill completed', { scannedCount, indexedCount });
        return { scannedCount, indexedCount };
    })().catch(async (error) => {
        await UnifiedReportState.updateOne(
            { key: REPORT_STATE_KEY },
            { $set: { status: 'failed', lastError: error.message } },
            { upsert: true }
        ).catch(() => {});
        throw error;
    }).finally(() => {
        backfillPromise = null;
    });

    return backfillPromise;
};

const scheduleChangeStreamRetry = () => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        startUnifiedReportSyncMonitor().catch((error) => {
            logger.error('Unified report change stream restart failed', { error: error.message });
            scheduleChangeStreamRetry();
        });
    }, 5000);
    retryTimer.unref?.();
};

const startUnifiedReportSyncMonitor = async () => {
    if (!isDatabaseReady() || changeStream) return changeStream;
    changeStream = Transaction.watch([], { fullDocument: 'updateLookup' });
    changeStream.on('change', async (change) => {
        try {
            if (change.operationType === 'delete') {
                await UnifiedReportEntry.deleteOne({ transactionId: change.documentKey?._id });
                return;
            }
            if (change.fullDocument) await syncReportTransaction(change.fullDocument);
        } catch (error) {
            logger.error('Unified report change sync failed', { error: error.message });
        }
    });
    changeStream.on('error', (error) => {
        logger.error('Unified report change stream stopped', { error: error.message });
        changeStream = null;
        scheduleChangeStreamRetry();
    });
    return changeStream;
};

const ensureUnifiedReportInfrastructure = async () => {
    if (!isDatabaseReady()) return false;
    await Promise.all([
        UnifiedReportEntry.createIndexes(),
        UnifiedReportState.createIndexes()
    ]);
    await startUnifiedReportSyncMonitor();
    setImmediate(() => {
        backfillUnifiedReports().catch((error) => {
            logger.error('Unified report background backfill failed', { error: error.message });
        });
    });
    return true;
};

const getUnifiedReportStatus = async () => {
    if (!isDatabaseReady()) return { status: 'offline' };
    const [state, entryCount, transactionCount] = await Promise.all([
        UnifiedReportState.findOne({ key: REPORT_STATE_KEY }).lean(),
        UnifiedReportEntry.estimatedDocumentCount(),
        Transaction.estimatedDocumentCount()
    ]);
    return {
        status: state?.status || 'pending',
        scannedCount: Number(state?.scannedCount || 0),
        indexedCount: Number(state?.indexedCount || 0),
        entryCount,
        transactionCount,
        completedAt: state?.completedAt || null,
        lastSyncedAt: state?.lastSyncedAt || null,
        lastError: state?.lastError || null
    };
};

module.exports = {
    REPORT_SNAPSHOT_VERSION,
    REPORT_STATE_KEY,
    backfillUnifiedReports,
    buildReportEntry,
    buildReportSnapshot,
    ensureUnifiedReportInfrastructure,
    findReportTransactions,
    getUnifiedReportStatus,
    startUnifiedReportSyncMonitor,
    syncReportTransaction,
    syncReportTransactions
};
