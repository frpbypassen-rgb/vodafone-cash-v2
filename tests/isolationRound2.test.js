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

jest.mock('../services/externalApiService', () => {
    const actual = jest.requireActual('../services/externalApiService');
    return {
        ...actual,
        saveApiReceiptProof: jest.fn(async () => 'proofs/provider-api-receipt.jpg')
    };
});

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
const queueService = require('../services/queueService');
const eventBus = require('../services/eventBus');
const { saveProofImage } = require('../services/proofStorageService');
const { saveApiReceiptProof } = require('../services/externalApiService');
const { listProviderPaidAwaitingCompletion } = require('../scripts/listProviderPaidAwaitingCompletion');
const { MongoServerError } = require('mongodb');

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

const paymentPosts = () => axios.post.mock.calls.filter((call) => String(call[0]).includes('/Transactions/Payment')).length;

const installProviderHttp = () => {
    axios.post.mockImplementation(async (url) => {
        const target = String(url);
        if (target.includes('/GetToken')) {
            return { data: { Code: 200, Data: { Access_Token: 'sandbox-token' } } };
        }
        if (target.includes('/GetBalance')) {
            return {
                data: {
                    Code: 200,
                    Data: { ServiceCredit: 1000, CashCredit: 0, AvailableBalance: 1000 }
                }
            };
        }
        if (target.includes('/Inquiry')) {
            return { data: { Code: 200, Data: { PaymentBillInfo: 'bill' } } };
        }
        if (target.includes('/Payment')) {
            return {
                data: {
                    Code: 200,
                    Data: {
                        TransactionNumber: '5001',
                        RefTransactionNumber: '2805',
                        Amount: 1600,
                        Status: 'عمليه ناجحه',
                        IsPaid: true
                    }
                }
            };
        }
        return { data: { Code: 200, Data: {} } };
    });
};

const insertCustomer = async (customId) => {
    const customerId = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('users').insertOne({
        _id: customerId,
        webUsername: `cust-${customId}`,
        webPassword: 'not-used',
        balance: 9000,
        name: 'Customer'
    });
    return customerId;
};

const expectNoCustomerMovement = async (customId, customerId) => {
    const customer = await mongoose.connection.collection('users').findOne({ _id: customerId });
    expect(customer.balance).toBe(9000);
    expect(await Ledger.countDocuments({
        transactionId: customId,
        type: { $in: ['REFUND', 'REVERSAL'] }
    })).toBe(0);
    expect(await Ledger.countDocuments({
        transactionId: customId,
        amount: { $gt: 0 }
    })).toBe(0);
};

describe('completion transaction boundary and immediate provider path', () => {
    const saved = {};

    beforeEach(() => {
        saved.FINANCIAL_SCHEDULERS_ENABLED = process.env.FINANCIAL_SCHEDULERS_ENABLED;
        saved.EXTERNAL_API_ENABLED = process.env.EXTERNAL_API_ENABLED;
        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
        delete process.env.EXTERNAL_API_ENABLED;
        axios.post.mockReset();
        axios.get.mockReset();
        eventBus.publish.mockClear();
        saveProofImage.mockClear();
        saveApiReceiptProof.mockClear();
        installProviderHttp();
    });

    afterEach(() => {
        if (saved.FINANCIAL_SCHEDULERS_ENABLED === undefined) delete process.env.FINANCIAL_SCHEDULERS_ENABLED;
        else process.env.FINANCIAL_SCHEDULERS_ENABLED = saved.FINANCIAL_SCHEDULERS_ENABLED;
        if (saved.EXTERNAL_API_ENABLED === undefined) delete process.env.EXTERNAL_API_ENABLED;
        else process.env.EXTERNAL_API_ENABLED = saved.EXTERNAL_API_ENABLED;
        jest.restoreAllMocks();
    });

    test('two concurrent immediate executions and two concurrent completions post one provider payment and one executor debit', async () => {
        const immediateId = 'ATT-IMM-CONCUR';
        const delayedId = 'ATT-DLY-CONCUR';
        const immediateCustomer = await insertCustomer(immediateId);
        const delayedCustomer = await insertCustomer(delayedId);
        const group = await ExecutorGroup.create({
            name: 'Immediate API',
            balance: 8000,
            isApiBot: true,
            apiUrl: 'https://sandbox.example',
            apiUsername: 'sandbox-user',
            apiPassword: 'sandbox-pass',
            serviceKey: 'vodafone'
        });
        const immediate = await Transaction.create({
            customId: immediateId,
            amount: 1600,
            status: 'processing',
            transferType: 'vodafone',
            executorGroupId: group._id,
            vodafoneNumber: '01000000000',
            userId: String(immediateCustomer)
        });
        const delayed = await Transaction.create({
            customId: delayedId,
            amount: 1600,
            status: 'processing',
            transferType: 'vodafone',
            executorGroupId: group._id,
            vodafoneNumber: '01000000001',
            userId: String(delayedCustomer),
            apiResultData: {
                waitingApiAutoCompletion: true,
                autoCompleteAt: new Date(Date.now() - 1000),
                referenceNumber: 'REF-DLY-CONCUR',
                externalTransactionId: 'PROV-DLY-CONCUR'
            }
        });

        await Promise.all([
            queueService.processSingleJob(immediate._id, group._id),
            queueService.processSingleJob(immediate._id, group._id)
        ]);
        const [first, second] = await Promise.all([
            completeApiTransaction(delayed._id, group._id),
            completeApiTransaction(delayed._id, group._id)
        ]);

        expect(paymentPosts()).toBe(1);
        expect(axios.post.mock.calls.filter((call) => String(call[0]).includes(delayedId))).toHaveLength(0);
        const immediateLedger = await Ledger.find({
            transactionId: immediateId,
            entityModel: 'ExecutorGroup',
            type: 'TRANSFER'
        }).lean();
        const delayedLedger = await Ledger.find({
            transactionId: delayedId,
            entityModel: 'ExecutorGroup',
            type: 'TRANSFER'
        }).lean();
        expect(immediateLedger).toHaveLength(1);
        expect(immediateLedger[0].amount).toBe(-1600);
        expect(delayedLedger).toHaveLength(1);
        expect(delayedLedger[0].amount).toBe(-1600);
        expect([first, second].filter((item) => item.completed)).toHaveLength(1);
        expect((await Transaction.findById(immediate._id).lean()).status).toBe('completed');
        expect((await Transaction.findById(delayed._id).lean()).status).toBe('completed');
        expect((await ExecutorGroup.findById(group._id).lean()).balance).toBe(4800);
        await expectNoCustomerMovement(immediateId, immediateCustomer);
        await expectNoCustomerMovement(delayedId, delayedCustomer);
        const delayedPublishes = eventBus.publish.mock.calls.filter((call) => (
            call[0] === 'transfer:completed' && call[1]?.tx?.customId === delayedId
        ));
        expect(delayedPublishes).toHaveLength(1);
        expect(await Notification.countDocuments({ txId: delayedId })).toBe(0);
        expect(await MerchantWebhookDelivery.countDocuments({
            eventId: new RegExp(String(delayed._id))
        })).toBe(0);
    });

    test('a hard crash after the provider accepts and before the immediate save is re-sent on retry', async () => {
        // Pre-existing on main dd152b76. queueService.js is unchanged by this PR.
        // processSingleJobSerialized calls executeTransferViaApi before tx.save,
        // and completeApiTransactionWithReference commits the executor debit in
        // its own session before that save. A kill in between leaves status
        // processing, so the next pass calls the provider again.
        const customId = 'ATT-IMM-CRASH';
        const customerId = await insertCustomer(customId);
        const group = await ExecutorGroup.create({
            name: 'Crash API',
            balance: 5000,
            isApiBot: true,
            apiUrl: 'https://sandbox.example',
            apiUsername: 'sandbox-user',
            apiPassword: 'sandbox-pass',
            serviceKey: 'vodafone'
        });
        const tx = await Transaction.create({
            customId,
            amount: 1600,
            status: 'processing',
            transferType: 'vodafone',
            executorGroupId: group._id,
            vodafoneNumber: '01000000000',
            userId: String(customerId)
        });
        const originalSave = Transaction.prototype.save;
        const saveSpy = jest.spyOn(Transaction.prototype, 'save').mockImplementation(() => {
            throw new Error('process died before completion save');
        });

        await queueService.processSingleJob(tx._id, group._id);
        saveSpy.mockRestore();

        const stuck = await Transaction.findById(tx._id).lean();
        expect(stuck.status).toBe('processing');
        expect(stuck.executorGroupId.toString()).toBe(group._id.toString());
        expect(stuck.apiResultData?.waitingApiAutoCompletion).not.toBe(true);
        expect(await Ledger.countDocuments({
            transactionId: customId,
            entityModel: 'ExecutorGroup',
            type: 'TRANSFER'
        })).toBe(1);
        expect(paymentPosts()).toBe(1);
        const listed = await listProviderPaidAwaitingCompletion(Transaction);
        expect(listed.some((row) => row.customId === customId)).toBe(false);
        const detected = await Transaction.findOne({
            customId,
            status: 'processing',
            executorGroupId: group._id,
            $or: [
                { 'apiResultData.waitingApiAutoCompletion': { $exists: false } },
                { 'apiResultData.waitingApiAutoCompletion': { $ne: true } }
            ]
        }).lean();
        expect(detected).toBeTruthy();

        await queueService.processSingleJob(tx._id, group._id);

        expect(paymentPosts()).toBe(2);
        const debits = await Ledger.find({
            transactionId: customId,
            entityModel: 'ExecutorGroup',
            type: 'TRANSFER'
        }).lean();
        expect(debits).toHaveLength(2);
        expect(debits.every((entry) => entry.amount === -1600)).toBe(true);
        expect((await Transaction.findById(tx._id).lean()).status).toBe('completed');
        expect((await ExecutorGroup.findById(group._id).lean()).balance).toBe(1800);
        await expectNoCustomerMovement(customId, customerId);
        expect(originalSave).toBe(Transaction.prototype.save);
    });

    test('a TransientTransactionError inside completeApiTransaction retries the callback once and does not repeat side effects', async () => {
        const customId = 'ATT-TXN-RETRY';
        const customerId = await insertCustomer(customId);
        const group = await ExecutorGroup.create({
            name: 'Retry API',
            balance: 5000,
            isApiBot: true,
            apiUrl: 'https://sandbox.example',
            apiUsername: 'sandbox-user',
            apiPassword: 'sandbox-pass',
            serviceKey: 'vodafone'
        });
        const tx = await Transaction.create({
            customId,
            amount: 1600,
            status: 'processing',
            transferType: 'vodafone',
            executorGroupId: group._id,
            vodafoneNumber: '01000000000',
            userId: String(customerId),
            apiResultData: {
                waitingApiAutoCompletion: true,
                autoCompleteAt: new Date(Date.now() - 1000),
                referenceNumber: 'REF-TXN-RETRY',
                externalTransactionId: 'PROV-TXN-RETRY'
            }
        });
        const originalSave = Transaction.prototype.save;
        let completedSaves = 0;
        const saveSpy = jest.spyOn(Transaction.prototype, 'save').mockImplementation(function mockedSave(options) {
            if (this.status === 'completed') {
                completedSaves += 1;
                if (completedSaves === 1) {
                    throw new MongoServerError({
                        message: 'WriteConflict',
                        errorLabels: ['TransientTransactionError']
                    });
                }
            }
            return originalSave.call(this, options);
        });

        await expect(completeApiTransaction(tx._id, group._id)).resolves.toEqual({ completed: true });
        saveSpy.mockRestore();

        expect(completedSaves).toBe(2);
        expect(paymentPosts()).toBe(0);
        expect(axios.post).not.toHaveBeenCalled();
        const debits = await Ledger.find({
            transactionId: customId,
            entityModel: 'ExecutorGroup',
            type: 'TRANSFER'
        }).lean();
        expect(debits).toHaveLength(1);
        expect(debits[0].amount).toBe(-1600);
        expect((await ExecutorGroup.findById(group._id).lean()).balance).toBe(3400);
        expect((await Transaction.findById(tx._id).lean()).status).toBe('completed');
        expect(saveProofImage).toHaveBeenCalledTimes(1);
        expect(eventBus.publish.mock.calls.filter((call) => (
            call[0] === 'transfer:completed' && call[1]?.tx?.customId === customId
        ))).toHaveLength(1);
        expect(await Notification.countDocuments({ txId: customId })).toBe(0);
        expect(await MerchantWebhookDelivery.countDocuments({
            eventId: new RegExp(String(tx._id))
        })).toBe(0);
        await expectNoCustomerMovement(customId, customerId);
    });
});
