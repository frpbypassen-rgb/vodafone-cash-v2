'use strict';

jest.mock('axios', () => ({
    post: jest.fn(),
    get: jest.fn()
}));

jest.mock('dns', () => ({
    promises: {
        lookup: jest.fn(async () => [{ address: '203.0.113.10', family: 4 }])
    }
}));

jest.mock('../services/eventBus', () => ({
    publish: jest.fn()
}));

jest.mock('../utils/manualExecutorReceipt', () => ({
    generateExecutorReceiptBase64: jest.fn(() => 'data:image/jpeg;base64,cmVjZWlwdA==')
}));

jest.mock('../services/proofStorageService', () => ({
    saveProofImage: jest.fn(() => 'proofs/system-api-receipt.jpg')
}));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const axios = require('axios');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Ledger = require('../models/Ledger');
const Notification = require('../models/Notification');
const MerchantWebhookDelivery = require('../models/MerchantWebhookDelivery');
const MerchantWebhookEndpoint = require('../models/MerchantWebhookEndpoint');
const { completeApiTransaction } = require('../services/apiExecutionLifecycleService');
const { encrypt } = require('../utils/encryption');
const {
    deliverWebhook,
    processPendingWebhooks
} = require('../services/merchantWebhookService');
const {
    addNotificationJob,
    recordInAppNotification
} = require('../services/bullQueueService');
const walletService = require('../services/walletService');
const { countIsolationBacklog } = require('../scripts/countIsolationBacklog');

jest.setTimeout(180000);

let replSet;

const indexedModels = () => [
    Transaction,
    ExecutorGroup,
    Ledger,
    Notification,
    MerchantWebhookDelivery,
    MerchantWebhookEndpoint
];

const ownerId = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
    indexedModels().forEach((model) => model.schema.set('autoIndex', false));
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replSet.getUri());
    await Notification.collection.createIndex({ dedupeKey: 1 }, { unique: true, sparse: true });
});

afterAll(async () => {
    indexedModels().forEach((model) => model.schema.set('autoIndex', true));
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
});

describe('concurrent provider-paid completion', () => {
    const saved = {};

    beforeEach(() => {
        saved.FINANCIAL_SCHEDULERS_ENABLED = process.env.FINANCIAL_SCHEDULERS_ENABLED;
        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
        axios.post.mockReset();
    });

    afterEach(() => {
        if (saved.FINANCIAL_SCHEDULERS_ENABLED === undefined) delete process.env.FINANCIAL_SCHEDULERS_ENABLED;
        else process.env.FINANCIAL_SCHEDULERS_ENABLED = saved.FINANCIAL_SCHEDULERS_ENABLED;
    });

    test('two concurrent completions debit the executor ledger once and do not call the provider', async () => {
        const group = await ExecutorGroup.create({ name: 'API Executor', balance: 5000, isApiBot: true });
        const tx = await Transaction.create({
            customId: 'ATT-CONCUR-0001',
            amount: 1600,
            status: 'processing',
            executorGroupId: group._id,
            vodafoneNumber: '01000000000',
            apiResultData: {
                waitingApiAutoCompletion: true,
                autoCompleteAt: new Date(Date.now() - 1000),
                referenceNumber: 'REF-CONCUR-1',
                externalTransactionId: 'PROV-CONCUR-1'
            }
        });

        const [first, second] = await Promise.all([
            completeApiTransaction(tx._id, group._id),
            completeApiTransaction(tx._id, group._id)
        ]);
        const third = await completeApiTransaction(tx._id, group._id);

        const results = [first, second];
        expect(results.filter((item) => item.completed).length).toBe(1);
        expect(results.filter((item) => item.reason === 'completion_already_claimed').length).toBe(1);
        expect(third.completed).toBe(false);

        const entries = await Ledger.find({ transactionId: 'ATT-CONCUR-0001' }).lean();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toEqual(expect.objectContaining({
            entityModel: 'ExecutorGroup',
            type: 'TRANSFER',
            amount: -1600,
            transactionId: 'ATT-CONCUR-0001',
            description: 'تنفيذ API آلي'
        }));
        expect(String(entries[0].entityId)).toBe(String(group._id));

        const updatedGroup = await ExecutorGroup.findById(group._id).lean();
        expect(updatedGroup.balance).toBe(3400);
        const updatedTx = await Transaction.findById(tx._id).lean();
        expect(updatedTx.status).toBe('completed');
        expect(updatedTx.apiResultData.waitingApiAutoCompletion).toBe(false);
        expect(axios.post).not.toHaveBeenCalled();
    });

    const waitingTransaction = async (customId) => {
        const group = await ExecutorGroup.create({ name: `API ${customId}`, balance: 5000, isApiBot: true });
        const tx = await Transaction.create({
            customId,
            amount: 1600,
            status: 'processing',
            executorGroupId: group._id,
            vodafoneNumber: '01000000000',
            apiResultData: {
                waitingApiAutoCompletion: true,
                autoCompleteAt: new Date(Date.now() - 1000),
                referenceNumber: `REF-${customId}`,
                externalTransactionId: `PROV-${customId}`
            }
        });
        return { group, tx };
    };

    test('a throw between claim and debit rolls the row back to waiting and a later pass debits once', async () => {
        const { group, tx } = await waitingTransaction('ATT-ABORT-CLAIM');
        const debit = jest.spyOn(walletService, 'updateBalanceWithLedger')
            .mockRejectedValueOnce(new Error('crash between claim and debit'));

        await expect(completeApiTransaction(tx._id, group._id)).resolves.toEqual({
            completed: false,
            reason: 'completion_aborted'
        });
        debit.mockRestore();

        const aborted = await Transaction.findById(tx._id).lean();
        expect(aborted.status).toBe('processing');
        expect(aborted.apiResultData.waitingApiAutoCompletion).toBe(true);
        expect(await Ledger.countDocuments({ transactionId: 'ATT-ABORT-CLAIM' })).toBe(0);
        expect((await ExecutorGroup.findById(group._id).lean()).balance).toBe(5000);

        await expect(completeApiTransaction(tx._id, group._id)).resolves.toEqual({ completed: true });
        await expect(completeApiTransaction(tx._id, group._id)).resolves.toEqual({
            completed: false,
            reason: 'invalid_status:completed'
        });
        expect(await Ledger.countDocuments({ transactionId: 'ATT-ABORT-CLAIM' })).toBe(1);
        expect((await ExecutorGroup.findById(group._id).lean()).balance).toBe(3400);
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('a throw between debit and save rolls the debit back and a later pass debits once', async () => {
        const { group, tx } = await waitingTransaction('ATT-ABORT-SAVE');
        const save = Transaction.prototype.save;
        const saveSpy = jest.spyOn(Transaction.prototype, 'save').mockImplementation(function mockedSave(options) {
            if (this.status === 'completed') {
                saveSpy.mockRestore();
                throw new Error('crash between debit and save');
            }
            return save.call(this, options);
        });

        try {
            await expect(completeApiTransaction(tx._id, group._id)).resolves.toEqual({
                completed: false,
                reason: 'completion_aborted'
            });
        } finally {
            saveSpy.mockRestore();
        }

        const aborted = await Transaction.findById(tx._id).lean();
        expect(aborted.status).toBe('processing');
        expect(aborted.apiResultData.waitingApiAutoCompletion).toBe(true);
        expect(await Ledger.countDocuments({ transactionId: 'ATT-ABORT-SAVE' })).toBe(0);
        expect((await ExecutorGroup.findById(group._id).lean()).balance).toBe(5000);

        await expect(completeApiTransaction(tx._id, group._id)).resolves.toEqual({ completed: true });
        expect(await Ledger.countDocuments({ transactionId: 'ATT-ABORT-SAVE' })).toBe(1);
        expect((await ExecutorGroup.findById(group._id).lean()).balance).toBe(3400);
        const entries = await Ledger.find({ transactionId: 'ATT-ABORT-SAVE' }).lean();
        expect(entries[0]).toEqual(expect.objectContaining({
            entityModel: 'ExecutorGroup',
            type: 'TRANSFER',
            amount: -1600,
            description: 'تنفيذ API آلي'
        }));
        expect(axios.post).not.toHaveBeenCalled();
    });
});

describe('merchant webhook crash after HTTP', () => {
    const saved = {};

    beforeEach(() => {
        saved.MERCHANT_WEBHOOK_WORKER_ENABLED = process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
        process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = 'true';
        axios.post.mockReset();
        axios.post.mockResolvedValue({ status: 204, data: '' });
    });

    afterEach(() => {
        if (saved.MERCHANT_WEBHOOK_WORKER_ENABLED === undefined) delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
        else process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = saved.MERCHANT_WEBHOOK_WORKER_ENABLED;
    });

    const createEndpoint = () => MerchantWebhookEndpoint.create({
        ownerModel: 'User',
        ownerId: ownerId(),
        url: 'https://hooks.example.test/pay',
        secretEncrypted: encrypt('webhook-secret'),
        events: ['transfer.completed'],
        enabled: true
    });

    test('a sending row left by a crash is not redelivered on the next poll', async () => {
        const endpoint = await createEndpoint();
        const eventId = `${new mongoose.Types.ObjectId()}:transfer.completed:completed`;
        const payload = { id: 'evt-crash', type: 'transfer.completed', data: { reference: 'ATT-WH-1' } };
        const delivery = await MerchantWebhookDelivery.create({
            endpointId: endpoint._id,
            ownerModel: 'User',
            ownerId: endpoint.ownerId,
            eventId,
            eventType: 'transfer.completed',
            payload,
            status: 'sending',
            attemptCount: 1,
            lockedAt: new Date(),
            lastAttemptAt: new Date(),
            nextAttemptAt: new Date(Date.now() - 1000)
        });

        axios.post.mockClear();
        const selected = await processPendingWebhooks();
        const fresh = await MerchantWebhookDelivery.findById(delivery._id).lean();
        expect(selected).toBe(0);
        expect(axios.post).not.toHaveBeenCalled();
        expect(fresh.status).toBe('sending');

        await expect(deliverWebhook(delivery._id)).resolves.toBeNull();
        expect(axios.post).not.toHaveBeenCalled();

        delivery.lockedAt = new Date(Date.now() - (3 * 60 * 1000));
        await delivery.save();
        axios.post.mockClear();
        expect(await processPendingWebhooks()).toBe(0);
        expect(axios.post).not.toHaveBeenCalled();

        const reclaimed = await deliverWebhook(delivery._id);
        expect(reclaimed).toEqual({ delivered: true });
        expect(axios.post).toHaveBeenCalledTimes(1);
        const headers = axios.post.mock.calls[0][2].headers;
        expect(headers['x-ahrampay-event-id']).toBe(eventId);
        expect(axios.post.mock.calls[0][1]).toBe(JSON.stringify(payload));
        expect(JSON.parse(axios.post.mock.calls[0][1]).id).toBe('evt-crash');
    });

    test('a thrown success write becomes failed and the next poll delivers again with the same event id', async () => {
        const endpoint = await createEndpoint();
        const eventId = `${new mongoose.Types.ObjectId()}:transfer.completed:completed`;
        const payload = { id: 'evt-retry', type: 'transfer.completed' };
        const delivery = await MerchantWebhookDelivery.create({
            endpointId: endpoint._id,
            ownerModel: 'User',
            ownerId: endpoint.ownerId,
            eventId,
            eventType: 'transfer.completed',
            payload,
            status: 'pending',
            attemptCount: 0,
            nextAttemptAt: new Date(Date.now() - 1000)
        });

        const updateOne = MerchantWebhookDelivery.updateOne;
        const spy = jest.spyOn(MerchantWebhookDelivery, 'updateOne').mockImplementation(function mocked(filter, update, ...rest) {
            if (update && update.$set && update.$set.status === 'delivered') {
                throw new Error('success write failed after HTTP');
            }
            return updateOne.call(this, filter, update, ...rest);
        });
        try {
            const first = await deliverWebhook(delivery._id);
            expect(first.delivered).toBe(false);
            expect(axios.post).toHaveBeenCalledTimes(1);
            expect(axios.post.mock.calls[0][2].headers['x-ahrampay-event-id']).toBe(eventId);
            const failed = await MerchantWebhookDelivery.findById(delivery._id).lean();
            expect(failed.status).toBe('failed');
            expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
        } finally {
            spy.mockRestore();
        }

        axios.post.mockClear();
        await processPendingWebhooks();
        expect(axios.post.mock.calls.filter((call) => (
            call[2] && call[2].headers && call[2].headers['x-ahrampay-event-id'] === eventId
        ))).toHaveLength(0);

        await MerchantWebhookDelivery.updateOne(
            { _id: delivery._id },
            { $set: { nextAttemptAt: new Date(Date.now() - 1000) } }
        );
        const selected = await processPendingWebhooks();
        expect(selected).toBeGreaterThanOrEqual(1);
        const matching = axios.post.mock.calls.filter((call) => (
            call[2].headers['x-ahrampay-event-id'] === eventId
        ));
        expect(matching).toHaveLength(1);
        expect(matching[0][1]).toBe(JSON.stringify(payload));
        const delivered = await MerchantWebhookDelivery.findById(delivery._id).lean();
        expect(delivered.status).toBe('delivered');
    });
});

describe('in-app notification dedupe across a BullMQ restart', () => {
    const saved = {};

    beforeEach(() => {
        saved.BULLMQ_WORKERS_ENABLED = process.env.BULLMQ_WORKERS_ENABLED;
    });

    afterEach(() => {
        if (saved.BULLMQ_WORKERS_ENABLED === undefined) delete process.env.BULLMQ_WORKERS_ENABLED;
        else process.env.BULLMQ_WORKERS_ENABLED = saved.BULLMQ_WORKERS_ENABLED;
    });

    test('a direct write and a later worker pass for the same explicit key create one row', async () => {
        process.env.BULLMQ_WORKERS_ENABLED = 'false';
        const userId = `user-${new mongoose.Types.ObjectId()}`;
        const title = 'طلب تحويل جديد';
        const message = 'تم استلام ATT-DEDUPE-1';
        const type = 'transfer';
        const dedupeKey = `ATT-DEDUPE-1:${userId}:transfer`;

        await addNotificationJob(userId, title, message, type, dedupeKey);
        expect(await Notification.countDocuments({ userId })).toBe(1);

        await recordInAppNotification({ userId, title, message, type, dedupeKey });
        expect(await Notification.countDocuments({ userId })).toBe(1);
        expect(await Notification.countDocuments({ dedupeKey })).toBe(1);
    });
});

describe('isolation backlog counts are read-only', () => {
    test('countIsolationBacklog only counts and the script has no delete commands', async () => {
        const source = fs.readFileSync(path.join(__dirname, '../scripts/countIsolationBacklog.js'), 'utf8');
        expect(source).not.toMatch(/deleteMany|deleteOne|updateOne|updateMany|remove\(|obliterate|drop\(/);

        const before = await countIsolationBacklog(mongoose.connection.db);
        const group = await ExecutorGroup.create({ name: 'Count Executor', balance: 10 });
        await Transaction.create({
            customId: `ATT-COUNT-${Date.now()}`,
            amount: 5,
            status: 'processing',
            executorGroupId: group._id,
            apiResultData: { waitingApiAutoCompletion: true }
        });
        const endpoint = await MerchantWebhookEndpoint.create({
            ownerModel: 'User',
            ownerId: ownerId(),
            url: 'https://hooks.example.test/count',
            secretEncrypted: encrypt('webhook-secret'),
            events: ['transfer.created'],
            enabled: true
        });
        await MerchantWebhookDelivery.create([
            {
                endpointId: endpoint._id,
                ownerModel: 'User',
                ownerId: endpoint.ownerId,
                eventId: `count-pending-${Date.now()}`,
                eventType: 'transfer.created',
                payload: { id: 'p' },
                status: 'pending'
            },
            {
                endpointId: endpoint._id,
                ownerModel: 'User',
                ownerId: endpoint.ownerId,
                eventId: `count-failed-${Date.now()}`,
                eventType: 'transfer.created',
                payload: { id: 'f' },
                status: 'failed'
            },
            {
                endpointId: endpoint._id,
                ownerModel: 'User',
                ownerId: endpoint.ownerId,
                eventId: `count-sending-${Date.now()}`,
                eventType: 'transfer.created',
                payload: { id: 's' },
                status: 'sending',
                lockedAt: new Date()
            },
            {
                endpointId: endpoint._id,
                ownerModel: 'User',
                ownerId: endpoint.ownerId,
                eventId: `count-sending-stale-${Date.now()}`,
                eventType: 'transfer.created',
                payload: { id: 'stale' },
                status: 'sending',
                lockedAt: new Date(Date.now() - (3 * 60 * 1000))
            }
        ]);
        const after = await countIsolationBacklog(mongoose.connection.db);
        expect(after.readOnly).toBe(true);
        expect(after.providerPaidAwaitingCompletion).toBe(before.providerPaidAwaitingCompletion + 1);
        expect(after.webhookPending).toBe(before.webhookPending + 1);
        expect(after.webhookFailed).toBe(before.webhookFailed + 1);
        expect(after.webhookSending).toBe(before.webhookSending + 2);
        expect(after.webhookSendingStale).toBe(before.webhookSendingStale + 1);
    });
});
