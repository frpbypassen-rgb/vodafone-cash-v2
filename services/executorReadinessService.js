'use strict';

const inspectTrustedDeviceIndexes = (indexes) => {
    const expiryIndexes = indexes.filter((index) => (
        index.key?.expiresAt === 1 && Object.keys(index.key).length === 1
    ));
    const passed = expiryIndexes.length === 1
        && expiryIndexes[0].expireAfterSeconds === 0
        && !expiryIndexes[0].partialFilterExpression;
    return {
        code: 'TRUSTED_DEVICE_TTL',
        passed,
        reason: passed ? 'TTL_INDEX_VALID' : 'TTL_INDEX_MISSING_OR_CONFLICTING'
    };
};

const inspectCompletionOutboxIndexes = (indexes) => {
    const transactionIndex = indexes.find((index) => index.key?.transactionId === 1
        && Object.keys(index.key).length === 1);
    const workIndex = indexes.find((index) => index.key?.status === 1
        && index.key?.availableAt === 1 && index.key?.createdAt === 1);
    const passed = Boolean(transactionIndex?.unique && workIndex);
    return {
        code: 'EXECUTOR_COMPLETION_OUTBOX_INDEXES',
        passed,
        reason: passed ? 'OUTBOX_INDEXES_VALID' : 'OUTBOX_INDEXES_MISSING_OR_INVALID'
    };
};

const inspectExecutorReadiness = async (connection) => {
    const db = connection.db;
    const hello = await db.admin().command({ hello: 1 });
    const topology = hello.msg === 'isdbgrid' ? 'sharded-cluster' : (hello.setName ? 'replica-set' : 'standalone');
    const checks = [{ code: 'MONGO_TRANSACTION_TOPOLOGY', passed: topology !== 'standalone', topology }];

    if (topology !== 'standalone') {
        const session = await connection.startSession();
        try {
            session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
            await db.collection('transactions').findOne({}, { projection: { _id: 1 }, session });
            checks.push({ code: 'MONGO_READ_ONLY_TRANSACTION', passed: true });
        } finally {
            try {
                if (session.inTransaction()) await session.abortTransaction();
            } finally {
                await session.endSession();
            }
        }
    }

    let indexes;
    try {
        indexes = await db.collection('trusteddevices').indexes();
    } catch (error) {
        if (error.code !== 26) throw error;
        indexes = [];
    }
    checks.push(inspectTrustedDeviceIndexes(indexes));
    let outboxIndexes;
    try {
        outboxIndexes = await db.collection('executorcompletionoutboxes').indexes();
    } catch (error) {
        if (error.code !== 26) throw error;
        outboxIndexes = [];
    }
    checks.push(inspectCompletionOutboxIndexes(outboxIndexes));
    return { ready: checks.every((check) => check.passed), checks };
};

module.exports = { inspectExecutorReadiness, inspectTrustedDeviceIndexes, inspectCompletionOutboxIndexes };
