'use strict';

/**
 * Behavioral interactions across #80 kill switches, #80 delayed completion
 * transaction, and #83 dispatch claim / unresolved hold. These are not
 * covered as one sequence by the single-PR suites.
 */

jest.mock('axios', () => ({
    post: jest.fn()
}));

jest.mock('../utils/puppeteerLoader', () => ({
    loadPuppeteer: jest.fn(async () => {
        throw new Error('puppeteer disabled in test');
    })
}));

jest.mock('../utils/receiptGenerator', () => ({
    generateReceiptBase64: jest.fn(async () => 'data:image/jpeg;base64,YQ==')
}));

jest.mock('../utils/manualExecutorReceipt', () => ({
    generateExecutorReceiptBase64: jest.fn(() => 'data:image/jpeg;base64,YQ==')
}));

jest.mock('../services/proofStorageService', () => ({
    saveProofImage: jest.fn(() => 'proofs/test-api.jpg')
}));

jest.mock('../services/whatsappReceiptDeliveryService', () => ({
    sendCompletedTransactionReceipt: jest.fn(async () => ({})),
    sendCancelledTransactionReceipt: jest.fn(async () => ({}))
}));

jest.mock('../services/whatsappService', () => ({
    sendWhatsAppAlert: jest.fn(async () => ({})),
    sendOtp: jest.fn(),
    sendLegacyWhatsAppMessage: jest.fn(),
    sendWhatChimpText: jest.fn()
}));

jest.mock('../services/splitPartProofService', () => ({
    issueSplitPartProofs: jest.fn(async () => ({ ok: true, parts: [] }))
}));

jest.mock('../services/cancellationReceiptService', () => ({
    attachCancellationReceipt: jest.fn(async () => null)
}));

jest.mock('../services/agencyJournalService', () => ({
    recordTransferRealization: jest.fn(async () => null),
    recordTransferReversal: jest.fn(async () => null)
}));

const axios = require('axios');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const queueService = require('../services/queueService');
const { addTransferJob } = require('../services/bullQueueService');
const { completeApiTransaction } = require('../services/apiExecutionLifecycleService');
const { enqueueAutoRouteIfNeeded } = require('../services/autoRouteService');
const { issueSplitPartProofs } = require('../services/splitPartProofService');

jest.setTimeout(180000);

let replSet;
let sequence = 0;
let paymentCalls = 0;

const armProvider = () => {
    paymentCalls = 0;
    axios.post.mockImplementation(async (url) => {
        const target = String(url);
        if (target.includes('/Account/GetBalance')) {
            return { data: { Code: 200, Data: { ServiceCredit: 5000, CashCredit: 0, AvailableBalance: 5000 } } };
        }
        if (target.includes('/Transactions/Inquiry')) {
            return { data: { Code: 200, Data: { PaymentBillInfo: 'bill-info' } } };
        }
        if (target.includes('/Transactions/Payment')) {
            paymentCalls += 1;
            return {
                data: {
                    Code: 200,
                    Message: 'عمليه ناجحه',
                    Data: {
                        TransactionNumber: '50011611',
                        RefTransactionNumber: '28059087',
                        Amount: 100,
                        IsPaid: 1,
                        IsFailure: 0
                    }
                }
            };
        }
        throw new Error(`unexpected provider url ${target}`);
    });
};

const createFixture = async () => {
    sequence += 1;
    const user = await User.create({
        name: 'عميل التجربة',
        phone: `010${String(20000000 + sequence)}`,
        webUsername: `stack-${sequence}@example.com`,
        webPassword: 'hashed-password',
        balance: 800,
        status: 'active'
    });
    const executor = await ExecutorGroup.create({
        name: `API Executor ${sequence}`,
        status: 'active',
        balance: 50000,
        isApiBot: true,
        isApiGroup: true,
        serviceKey: 'vodafone',
        apiProviderKey: 'zayn_external_aggregator',
        apiUrl: 'https://provider.test',
        apiToken: 'static-test-token',
        apiMachineSerial: 'XP1'
    });
    const tx = await Transaction.create({
        customId: `ATT-STACK-${sequence}`,
        userId: user.phone,
        companyName: 'عميل فردي',
        employeeName: 'عميل التجربة',
        transferType: 'vodafone',
        vodafoneNumber: '01099887766',
        amount: 100,
        costLYD: 40,
        status: 'processing',
        executorGroupId: executor._id,
        executorName: executor.name
    });
    return { user, executor, tx };
};

const executorDebitCount = (customId) => Ledger.countDocuments({
    transactionId: customId,
    entityModel: 'ExecutorGroup',
    type: 'TRANSFER',
    description: 'تنفيذ API آلي'
});

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replSet.getUri(), { serverSelectionTimeoutMS: 20000 });
});

afterAll(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
});

afterEach(async () => {
    delete process.env.EXTERNAL_API_ENABLED;
    delete process.env.BULLMQ_WORKERS_ENABLED;
    delete process.env.FINANCIAL_SCHEDULERS_ENABLED;
    queueService.queue.length = 0;
    queueService.isProcessing = false;
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

describe('stacked kill switch and dispatch claim', () => {
    test('a switch-off refusal happens before the dispatch claim and leaves no marker', async () => {
        armProvider();
        process.env.EXTERNAL_API_ENABLED = 'false';
        const { executor, tx } = await createFixture();

        await queueService.processSingleJob(String(tx._id), String(executor._id));
        const stored = await Transaction.findById(tx._id);

        expect(paymentCalls).toBe(0);
        expect(axios.post).not.toHaveBeenCalled();
        expect(stored.status).toBe('pending');
        expect(stored.executorGroupId).toBeUndefined();
        expect(stored.apiResultData && stored.apiResultData.providerDispatchStartedAt).toBeFalsy();
        expect(stored.apiResultData && stored.apiResultData.providerDispatchAttemptId).toBeFalsy();
        expect(stored.apiResultData && stored.apiResultData.providerResultUnresolved).not.toBe(true);
        expect(await executorDebitCount(tx.customId)).toBe(0);
        expect(await Ledger.countDocuments({ transactionId: tx.customId, type: 'REFUND' })).toBe(0);
    });

    test('a claimed row is not re-sent when the provider switch is later turned off', async () => {
        armProvider();
        const { executor, tx } = await createFixture();
        tx.apiResultData = {
            providerDispatchStartedAt: new Date(),
            providerDispatchAttemptId: 'attempt-already-sent',
            providerDispatchExecutorGroupId: executor._id
        };
        await tx.save();
        process.env.EXTERNAL_API_ENABLED = 'false';

        const result = await queueService.processSingleJob(String(tx._id), String(executor._id));
        const stored = await Transaction.findById(tx._id);

        expect(result).toMatchObject({ skipped: true, code: 'PROVIDER_RESULT_UNRESOLVED' });
        expect(paymentCalls).toBe(0);
        expect(stored.status).toBe('processing');
        expect(String(stored.executorGroupId)).toBe(String(executor._id));
        expect(stored.apiResultData.providerDispatchAttemptId).toBe('attempt-already-sent');
        expect(stored.apiResultData.providerResultUnresolved).toBe(true);
        expect(await executorDebitCount(tx.customId)).toBe(0);
    });

    test('BullMQ disabled returns before the unresolved guard and does not enqueue a Payment', async () => {
        armProvider();
        process.env.BULLMQ_WORKERS_ENABLED = 'false';
        const { executor, tx } = await createFixture();
        tx.apiResultData = {
            providerDispatchStartedAt: new Date(),
            providerDispatchAttemptId: 'attempt-workers-off'
        };
        await tx.save();

        const queued = await addTransferJob(String(tx._id), String(executor._id));
        const stored = await Transaction.findById(tx._id);

        expect(queued).toBeUndefined();
        expect(paymentCalls).toBe(0);
        expect(stored.apiResultData.providerResultUnresolved).not.toBe(true);
        expect(stored.apiResultData.providerDispatchAttemptId).toBe('attempt-workers-off');
        expect(stored.status).toBe('processing');
    });

    test('auto-route refuses a disabled provider before it touches an unresolved hold', async () => {
        process.env.EXTERNAL_API_ENABLED = 'false';
        const { executor, tx } = await createFixture();
        const result = await enqueueAutoRouteIfNeeded(tx, executor);
        const stored = await Transaction.findById(tx._id);

        expect(result).toMatchObject({ queued: false, code: 'API_EXECUTION_UNAVAILABLE', reason: 'EXTERNAL_API_DISABLED' });
        expect(stored.apiResultData && stored.apiResultData.providerResultUnresolved).not.toBe(true);
        expect(issueSplitPartProofs).not.toHaveBeenCalled();
    });

    test('delayed completion stays in the transaction and refuses an unresolved or scheduler-off row', async () => {
        const { executor, tx } = await createFixture();
        tx.apiResultData = {
            waitingApiAutoCompletion: true,
            autoCompleteAt: new Date(Date.now() - 1000),
            referenceNumber: 'REF-STACK-1',
            providerResultUnresolved: true,
            providerDispatchAttemptId: 'attempt-delayed'
        };
        await tx.save();

        const held = await completeApiTransaction(tx._id, executor._id);
        const afterHold = await Transaction.findById(tx._id);
        expect(held).toEqual({ completed: false, reason: 'provider_result_unresolved' });
        expect(afterHold.status).toBe('processing');
        expect(afterHold.apiResultData.waitingApiAutoCompletion).toBe(true);
        expect(await executorDebitCount(tx.customId)).toBe(0);

        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
        afterHold.apiResultData.providerResultUnresolved = false;
        afterHold.markModified('apiResultData');
        await afterHold.save();
        const switched = await completeApiTransaction(tx._id, executor._id);
        const afterSwitch = await Transaction.findById(tx._id);
        expect(switched).toEqual({ completed: false, reason: 'financial_schedulers_disabled' });
        expect(afterSwitch.apiResultData.waitingApiAutoCompletion).toBe(true);
        expect(await executorDebitCount(tx.customId)).toBe(0);

        delete process.env.FINANCIAL_SCHEDULERS_ENABLED;
        const completed = await completeApiTransaction(tx._id, executor._id);
        const again = await completeApiTransaction(tx._id, executor._id);
        const finalTx = await Transaction.findById(tx._id);
        expect(completed).toEqual({ completed: true });
        expect(again.completed).toBe(false);
        expect(finalTx.status).toBe('completed');
        expect(await executorDebitCount(tx.customId)).toBe(1);
        expect(await Ledger.countDocuments({ transactionId: tx.customId, type: 'REFUND' })).toBe(0);
        expect(issueSplitPartProofs).not.toHaveBeenCalled();
    });
});
