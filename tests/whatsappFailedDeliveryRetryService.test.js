'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../models/WhatsAppDelivery', () => ({
    find: jest.fn(),
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    countDocuments: jest.fn()
}));

jest.mock('../models/Transaction', () => ({
    find: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
    deleteOne: jest.fn(),
    deleteMany: jest.fn(),
    save: jest.fn()
}));

jest.mock('../models/Ledger', () => ({
    updateOne: jest.fn(),
    updateMany: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
    deleteOne: jest.fn(),
    deleteMany: jest.fn()
}));

jest.mock('../models/JournalEvent', () => ({
    updateOne: jest.fn(),
    create: jest.fn(),
    deleteOne: jest.fn()
}));

jest.mock('../models/BulkJobLock', () => ({
    collection: { findOne: jest.fn(), deleteMany: jest.fn() },
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
    deleteOne: jest.fn()
}));

jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));

jest.mock('../services/whatsappReceiptDeliveryService', () => ({
    sendCompletedTransactionReceipt: jest.fn(),
    sendSplitPartReceipt: jest.fn()
}));

const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const JournalEvent = require('../models/JournalEvent');
const BulkJobLock = require('../models/BulkJobLock');
const { logAction } = require('../services/auditService');
const {
    sendCompletedTransactionReceipt,
    sendSplitPartReceipt
} = require('../services/whatsappReceiptDeliveryService');
const {
    ineligibilityReason,
    partitionCandidates,
    previewFailedRetries,
    resolveBatchCap,
    resolveMaxAttempts,
    resolveThrottleMs,
    resolveWindow,
    retryFailedDeliveries
} = require('../services/whatsappFailedDeliveryRetryService');

const actor = { id: 'admin-1', name: 'ماي', role: 'master' };
const request = {
    method: 'POST',
    originalUrl: '/whatsapp-monitor/failed-retries',
    headers: {},
    ip: '127.0.0.1',
    session: { adminId: 'admin-1', adminName: 'ماي' }
};

const records = new Map();
const transactions = new Map();

const clone = (row) => ({ ...row, metadata: { ...(row.metadata || {}) } });

const matchesAttemptCap = (row, query) => {
    if (!query.$or) return true;
    const attempts = row.metadata?.manualRetryCount;
    return query.$or.some((clause) => {
        const rule = clause['metadata.manualRetryCount'];
        if (!rule) return false;
        if (rule.$exists === false || rule === null) return attempts == null;
        if (rule.$lt != null) return attempts != null && Number(attempts) < rule.$lt;
        return false;
    });
};

const matchesQuery = (row, query) => {
    if (query.status && !query.status.$in && row.status !== query.status) return false;
    if (query.status?.$in && !query.status.$in.includes(row.status)) return false;
    if (query.kind?.$in && !query.kind.$in.includes(row.kind)) return false;
    if (query.updatedAt?.$gte && new Date(row.updatedAt) < new Date(query.updatedAt.$gte)) return false;
    if (query.transactionId?.$in && !query.transactionId.$in.map(String).includes(String(row.transactionId))) return false;
    if (!matchesAttemptCap(row, query)) return false;
    return true;
};

const baseContext = (overrides = {}) => ({
    successes: [],
    allowedTransactionIds: new Set(['tx-1']),
    maxAttempts: 3,
    since: new Date(Date.now() - (72 * 60 * 60 * 1000)),
    tenantRestricted: false,
    ...overrides
});

const delivery = (overrides = {}) => ({
    _id: 'd-1',
    kind: 'receipt',
    status: 'failed',
    transactionId: 'tx-1',
    reference: 'ATT-1',
    updatedAt: new Date(),
    metadata: {},
    ...overrides
});

describe('failed WhatsApp delivery eligibility', () => {
    test('includes failed receipts and excludes every non-stopped status', () => {
        const context = baseContext();
        expect(ineligibilityReason(delivery(), context)).toBeNull();
        ['pending', 'sending', 'sent', 'delivered', 'read', 'skipped'].forEach((status) => {
            expect(ineligibilityReason(delivery({ status }), context)).toBe('STATUS_NOT_STOPPED');
        });
    });

    test('skips a transaction that already has a successful receipt of the same kind', () => {
        const failed = delivery();
        const context = baseContext({
            successes: [{ _id: 'd-ok', kind: 'receipt', status: 'delivered', transactionId: 'tx-1' }]
        });
        expect(ineligibilityReason(failed, context)).toBe('ALREADY_SUCCEEDED');
    });

    test.each(['WHATCHIMP_TIMEOUT', 'WHATCHIMP_REQUEST_FAILED', 'RETRY_SEND_FAILED',
        'RECEIPT_DELIVERY_FAILED', 'PART_PROOF_SEND_FAILED', 'RETRY_SUPERSEDED'])(
        'does not resend an unresolved provider outcome: %s', (failureCode) => {
            expect(ineligibilityReason(delivery({ failureCode }), baseContext())).toBe('PROVIDER_RESULT_UNRESOLVED');
        }
    );

    test('retries a different split part and skips the part that already succeeded', () => {
        const context = baseContext({
            successes: [{
                _id: 'part-ok',
                kind: 'part_receipt',
                status: 'read',
                transactionId: 'tx-1',
                metadata: { partKey: 'part-a', partId: 'a' }
            }]
        });
        const failedA = delivery({
            _id: 'part-a-row',
            kind: 'part_receipt',
            metadata: { partKey: 'part-a', partId: 'a' }
        });
        const failedB = delivery({
            _id: 'part-b-row',
            kind: 'part_receipt',
            metadata: { partKey: 'part-b', partId: 'b' }
        });
        expect(ineligibilityReason(failedA, context)).toBe('ALREADY_SUCCEEDED');
        expect(ineligibilityReason(failedB, context)).toBeNull();
    });

    test('stops retrying a record that already used the attempt cap', () => {
        const context = baseContext({ maxAttempts: 3 });
        expect(ineligibilityReason(delivery({ metadata: { manualRetryCount: 3 } }), context)).toBe('RETRY_CAP_EXCEEDED');
        expect(ineligibilityReason(delivery({ metadata: { manualRetryCount: 2 } }), context)).toBeNull();
    });

    test('excludes rate-change notifications and other kinds', () => {
        const context = baseContext();
        expect(ineligibilityReason(delivery({ kind: 'rate_change' }), context)).toBe('RATE_CHANGE_EXCLUDED');
        expect(ineligibilityReason(delivery({ kind: 'otp' }), context)).toBe('KIND_EXCLUDED');
        expect(ineligibilityReason(delivery({ kind: 'cancellation_receipt' }), context)).toBe('KIND_EXCLUDED');
    });

    test('hides deliveries that belong to another tenant', () => {
        const foreign = delivery({ transactionId: 'tx-other' });
        const partitioned = partitionCandidates([foreign, delivery()], baseContext({
            tenantRestricted: true,
            allowedTransactionIds: new Set(['tx-1'])
        }));
        expect(partitioned.eligible.map((row) => row._id)).toEqual(['d-1']);
        expect(partitioned.skipped).toEqual([]);
    });
});

describe('failed WhatsApp delivery bulk retry', () => {
    const envKeys = [
        'WHATSAPP_FAILED_RETRY_BATCH_CAP',
        'WHATSAPP_FAILED_RETRY_MAX_ATTEMPTS',
        'WHATSAPP_FAILED_RETRY_THROTTLE_MS'
    ];
    const previousEnv = new Map();

    beforeAll(() => {
        envKeys.forEach((key) => previousEnv.set(key, process.env[key]));
    });

    beforeEach(() => {
        jest.clearAllMocks();
        envKeys.forEach((key) => delete process.env[key]);
        records.clear();
        transactions.clear();
        transactions.set('tx-1', { _id: 'tx-1', tenantId: 'tenant-a', executorSenderEntries: [] });
        logAction.mockResolvedValue(undefined);
        BulkJobLock.findOneAndUpdate.mockResolvedValue(null);
        BulkJobLock.collection.findOne.mockResolvedValue(null);
        BulkJobLock.collection.deleteMany.mockResolvedValue({ deletedCount: 0 });
        BulkJobLock.create.mockResolvedValue({ key: 'whatsapp-monitor-failed-retry' });
        BulkJobLock.updateOne.mockResolvedValue({ matchedCount: 1 });
        BulkJobLock.deleteOne.mockResolvedValue({ deletedCount: 1 });
        WhatsAppDelivery.find.mockImplementation((query) => ({
            sort() { return this; },
            limit(value) { this.cap = value; return this; },
            select() { return this; },
            async lean() { return [...records.values()].filter((row) => matchesQuery(row, query)).slice(0, this.cap).map(clone); }
        }));
        WhatsAppDelivery.countDocuments.mockImplementation(async (query) => (
            [...records.values()].filter((row) => matchesQuery(row, query)).length
        ));
        WhatsAppDelivery.findOneAndUpdate.mockImplementation(async (filter, update) => {
            const row = records.get(String(filter._id));
            if (!row || row.status !== filter.status || row.kind !== filter.kind) return null;
            const cap = filter.$or?.map((clause) => clause['metadata.manualRetryCount']?.$lt).find((value) => value != null);
            const attempts = Number(row.metadata?.manualRetryCount || 0);
            if (row.metadata?.manualRetryCount != null && cap != null && attempts >= cap) return null;
            row.status = update.$set.status;
            row.metadata = {
                ...(row.metadata || {}),
                manualRetryCount: attempts + Number(update.$inc['metadata.manualRetryCount'] || 0)
            };
            return clone(row);
        });
        WhatsAppDelivery.findById.mockImplementation((id) => ({
            select: () => ({
                lean: async () => {
                    const row = records.get(String(id));
                    return row ? clone(row) : null;
                }
            })
        }));
        WhatsAppDelivery.updateOne.mockImplementation(async (filter, update) => {
            const row = records.get(String(filter._id));
            if (!row || (filter.status && row.status !== filter.status)) return { matchedCount: 0 };
            Object.assign(row, update.$set);
            return { matchedCount: 1 };
        });
        Transaction.find.mockImplementation((query) => ({
            select: () => ({
                lean: async () => (query._id?.$in || [...transactions.keys()]).map(String).filter((id) => {
                    const transaction = transactions.get(id);
                    if (!transaction) return false;
                    if (query.tenantId && String(transaction.tenantId) !== String(query.tenantId)) return false;
                    return true;
                }).map((id) => ({ _id: id }))
            })
        }));
        Transaction.findById.mockImplementation((id) => ({
            select: () => ({
                lean: async () => transactions.get(String(id)) || null
            })
        }));
        sendCompletedTransactionReceipt.mockImplementation(async (transactionId) => {
            const row = [...records.values()].find((item) => item.kind === 'receipt' && String(item.transactionId) === String(transactionId));
            if (row && row.status === 'sending') {
                row.status = 'sent';
                row.messageId = `mid-${transactionId}`;
            }
            return { success: true, messageId: `mid-${transactionId}` };
        });
        sendSplitPartReceipt.mockImplementation(async (args) => {
            const row = [...records.values()].find((item) => (
                item.kind === 'part_receipt' && item.metadata?.partKey === args.partKey
            ));
            if (row && row.status === 'sending') {
                row.status = 'sent';
                row.messageId = `mid-${args.partKey}`;
            }
            return { success: true, messageId: `mid-${args.partKey}`, partId: args.partId };
        });
    });

    afterAll(() => {
        envKeys.forEach((key) => {
            if (previousEnv.get(key) === undefined) delete process.env[key];
            else process.env[key] = previousEnv.get(key);
        });
    });

    const remember = (row) => {
        records.set(String(row._id), clone(row));
        return row;
    };

    test('uses safe defaults when retry env vars are unset or out of range', () => {
        expect(resolveBatchCap()).toBe(50);
        expect(resolveMaxAttempts()).toBe(3);
        expect(resolveThrottleMs()).toBe(500);
        expect(resolveWindow('30d').key).toBe('72h');
        process.env.WHATSAPP_FAILED_RETRY_BATCH_CAP = '999';
        process.env.WHATSAPP_FAILED_RETRY_MAX_ATTEMPTS = '0';
        process.env.WHATSAPP_FAILED_RETRY_THROTTLE_MS = '1';
        expect(resolveBatchCap()).toBe(50);
        expect(resolveMaxAttempts()).toBe(3);
        expect(resolveThrottleMs()).toBe(500);
        process.env.WHATSAPP_FAILED_RETRY_BATCH_CAP = '10';
        expect(resolveBatchCap()).toBe(10);
    });

    test('retries a failed receipt and a failed split part through their existing send paths', async () => {
        remember(delivery());
        remember(delivery({
            _id: 'part-1',
            kind: 'part_receipt',
            reference: 'ATT-1:p1',
            metadata: { partKey: 'part-1', partId: 'p1', amount: 25 }
        }));
        remember(delivery({ _id: 'rate-1', kind: 'rate_change', transactionId: 'tx-1', reference: 'RATE-1' }));
        remember(delivery({ _id: 'sent-1', kind: 'receipt', status: 'sent', transactionId: 'tx-2', reference: 'ATT-2' }));
        transactions.set('tx-2', { _id: 'tx-2', tenantId: 'tenant-a' });

        const summary = await retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 });

        expect(sendCompletedTransactionReceipt).toHaveBeenCalledTimes(1);
        expect(sendCompletedTransactionReceipt).toHaveBeenCalledWith('tx-1');
        expect(sendSplitPartReceipt).toHaveBeenCalledWith(expect.objectContaining({
            transactionId: 'tx-1',
            partId: 'p1',
            partKey: 'part-1',
            amount: 25
        }));
        expect(summary.attempted).toBe(2);
        expect(summary.accepted).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'd-1', messageId: 'mid-tx-1' }),
            expect.objectContaining({ id: 'part-1', messageId: 'mid-part-1' })
        ]));
        expect(summary.accepted.map((item) => item.id)).not.toContain('rate-1');
        expect(summary.accepted.map((item) => item.id)).not.toContain('sent-1');
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'WHATSAPP_FAILED_DELIVERIES_BULK_RETRY',
            performedById: 'admin-1',
            performedByName: 'ماي',
            targetModel: 'WhatsAppDelivery'
        }));
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'WHATSAPP_FAILED_DELIVERY_RETRIED',
            targetId: 'd-1',
            targetModel: 'WhatsAppDelivery',
            success: true
        }));
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'WHATSAPP_FAILED_DELIVERY_RETRIED',
            targetId: 'part-1'
        }));
    });

    test('does not retry a failed receipt when the transaction already has a successful one', async () => {
        remember(delivery({ _id: 'failed-copy', reference: 'ATT-1-b' }));
        remember(delivery({ _id: 'ok-1', status: 'delivered', reference: 'ATT-1' }));

        const summary = await retryFailedDeliveries({ tenantFilter: {}, window: '7d', actor, req: request, throttleMs: 0 });

        expect(sendCompletedTransactionReceipt).not.toHaveBeenCalled();
        expect(summary.attempted).toBe(0);
        expect(summary.skipped).toEqual([expect.objectContaining({ id: 'failed-copy', reason: 'ALREADY_SUCCEEDED' })]);
    });

    test('groups messages that fail again and reports how many remain past the batch cap', async () => {
        process.env.WHATSAPP_FAILED_RETRY_BATCH_CAP = '1';
        remember(delivery({ _id: 'old', transactionId: 'tx-old', reference: 'OLD', updatedAt: new Date(Date.now() - (10 * 60 * 1000)) }));
        remember(delivery({ _id: 'new', transactionId: 'tx-new', reference: 'NEW', updatedAt: new Date() }));
        transactions.set('tx-old', { _id: 'tx-old', tenantId: 'tenant-a' });
        transactions.set('tx-new', { _id: 'tx-new', tenantId: 'tenant-a' });
        sendCompletedTransactionReceipt.mockImplementation(async (transactionId) => {
            const row = [...records.values()].find((item) => String(item.transactionId) === String(transactionId));
            if (row) row.status = 'failed';
            return { success: false, code: 'TEMPLATE_REJECTED', message: 'template mismatch' };
        });

        const summary = await retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 });

        expect(summary.attempted).toBe(1);
        expect(summary.remaining).toBe(1);
        expect(summary.failedAgain.TEMPLATE_REJECTED).toHaveLength(1);
        expect(summary.accepted).toEqual([]);
        expect(sendCompletedTransactionReceipt).toHaveBeenCalledTimes(1);
    });

    test('does not claim a record that already reached the attempt cap', async () => {
        remember(delivery({ metadata: { manualRetryCount: 3 } }));

        const summary = await retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 });

        expect(sendCompletedTransactionReceipt).not.toHaveBeenCalled();
        expect(WhatsAppDelivery.findOneAndUpdate).not.toHaveBeenCalled();
        expect(summary.attempted).toBe(0);
    });

    test('keeps another tenant delivery out of the retry set', async () => {
        remember(delivery({ _id: 'mine', transactionId: 'tx-1', reference: 'MINE' }));
        remember(delivery({ _id: 'theirs', transactionId: 'tx-b', reference: 'THEIRS' }));
        transactions.set('tx-b', { _id: 'tx-b', tenantId: 'tenant-b' });

        const summary = await retryFailedDeliveries({
            tenantFilter: { tenantId: 'tenant-a' },
            window: '72h',
            actor,
            req: request,
            throttleMs: 0
        });

        expect(sendCompletedTransactionReceipt).toHaveBeenCalledTimes(1);
        expect(sendCompletedTransactionReceipt).toHaveBeenCalledWith('tx-1');
        expect(summary.accepted.map((item) => item.id)).toEqual(['mine']);
        expect(JSON.stringify(summary)).not.toContain('theirs');
        expect(JSON.stringify(summary)).not.toContain('tx-b');
    });

    test('scopes the database query before its 1000-record candidate limit', async () => {
        transactions.set('tx-b', { _id: 'tx-b', tenantId: 'tenant-b' });
        for (let index = 0; index < 1001; index += 1) {
            remember(delivery({ _id: `foreign-${index}`, transactionId: 'tx-b' }));
        }
        remember(delivery({ _id: 'mine' }));
        const preview = await previewFailedRetries({ tenantFilter: { tenantId: 'tenant-a' }, window: '72h' });
        expect(preview.willAttempt).toBe(1);
        expect(WhatsAppDelivery.find).toHaveBeenCalledWith(expect.objectContaining({
            transactionId: { $in: ['tx-1'] }
        }));
    });

    test('uncertain provider outcomes are not sent or claimed', async () => {
        remember(delivery({ failureCode: 'WHATCHIMP_TIMEOUT' }));
        const summary = await retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 });
        expect(summary.attempted).toBe(0);
        expect(WhatsAppDelivery.findOneAndUpdate).not.toHaveBeenCalled();
        expect(sendCompletedTransactionReceipt).not.toHaveBeenCalled();
    });

    test('batch locks use the mandatory unique MongoDB identifier', async () => {
        await retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 });
        expect(BulkJobLock.create).toHaveBeenCalledWith(expect.objectContaining({
            _id: 'whatsapp-monitor-failed-retry'
        }));
        expect(BulkJobLock.deleteOne).toHaveBeenCalledWith(expect.objectContaining({
            _id: 'whatsapp-monitor-failed-retry'
        }));
    });

    test('waits for an active lock created by the older release', async () => {
        BulkJobLock.collection.findOne.mockResolvedValue({ ownerId: 'old-worker' });
        remember(delivery());
        const summary = await retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 });
        expect(summary.code).toBe('BULK_RETRY_BUSY');
        expect(BulkJobLock.collection.deleteMany).not.toHaveBeenCalled();
        expect(BulkJobLock.create).not.toHaveBeenCalled();
        expect(sendCompletedTransactionReceipt).not.toHaveBeenCalled();
    });

    test('two parallel runs retry each failed record once', async () => {
        remember(delivery({ _id: 'once', transactionId: 'tx-1' }));
        let sends = 0;
        sendCompletedTransactionReceipt.mockImplementation(async () => {
            sends += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            const row = records.get('once');
            if (row) {
                row.status = 'sent';
                row.messageId = 'mid-once';
            }
            return { success: true, messageId: 'mid-once' };
        });

        const [first, second] = await Promise.all([
            retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 }),
            retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 })
        ]);

        expect(sends).toBe(1);
        const attempted = first.attempted + second.attempted;
        expect(attempted).toBe(1);
        expect(records.get('once').metadata.manualRetryCount).toBe(1);
    });

    test('a second run waits when the global lock is already held', async () => {
        remember(delivery());
        BulkJobLock.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));

        const summary = await retryFailedDeliveries({ tenantFilter: {}, window: '72h', actor, req: request, throttleMs: 0 });

        expect(summary.code).toBe('BULK_RETRY_BUSY');
        expect(summary.attempted).toBe(0);
        expect(sendCompletedTransactionReceipt).not.toHaveBeenCalled();
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'WHATSAPP_FAILED_DELIVERIES_BULK_RETRY',
            success: false,
            errorCode: 'BULK_RETRY_BUSY'
        }));
    });

    test('does not write ledger, journal, or transaction mutations', async () => {
        remember(delivery());
        const source = fs.readFileSync(path.join(__dirname, '../services/whatsappFailedDeliveryRetryService.js'), 'utf8');

        await retryFailedDeliveries({ tenantFilter: {}, window: '24h', actor, req: request, throttleMs: 0 });

        expect(source).not.toMatch(/models\/Ledger|models\/JournalEvent|WHATSAPP_OTP_ENABLED|merchantWebhook/);
        expect(Transaction.updateOne).not.toHaveBeenCalled();
        expect(Transaction.updateMany).not.toHaveBeenCalled();
        expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
        expect(Transaction.create).not.toHaveBeenCalled();
        expect(Transaction.deleteOne).not.toHaveBeenCalled();
        expect(Transaction.deleteMany).not.toHaveBeenCalled();
        expect(Ledger.updateOne).not.toHaveBeenCalled();
        expect(Ledger.create).not.toHaveBeenCalled();
        expect(Ledger.deleteOne).not.toHaveBeenCalled();
        expect(JournalEvent.create).not.toHaveBeenCalled();
        expect(JournalEvent.updateOne).not.toHaveBeenCalled();
        expect(JournalEvent.deleteOne).not.toHaveBeenCalled();
    });

    test('preview counts eligible receipts and parts without sending', async () => {
        remember(delivery());
        remember(delivery({
            _id: 'part-1',
            kind: 'part_receipt',
            metadata: { partKey: 'part-1', partId: 'p1' }
        }));
        remember(delivery({ _id: 'sending-1', status: 'sending' }));

        const preview = await previewFailedRetries({ tenantFilter: {}, window: '72h' });

        expect(preview.byKind).toEqual({ receipt: 1, part_receipt: 1 });
        expect(preview.willAttempt).toBe(2);
        expect(preview.excludedRateChange).toBe(true);
        expect(preview.stoppedStatus).toBe('failed');
        expect(sendCompletedTransactionReceipt).not.toHaveBeenCalled();
        expect(sendSplitPartReceipt).not.toHaveBeenCalled();
        expect(WhatsAppDelivery.findOneAndUpdate).not.toHaveBeenCalled();
    });
});
