'use strict';

/**
 * Reproduction tests for two pre-existing API execution defects.
 * Assertions describe the safe outcome. On main (before the dispatch claim)
 * the defect cases fail; after the fix they pass.
 *
 * Defect 1: crash after Payment success, before tx.save, then retry/restart.
 * Defect 2: timeout / ECONNRESET / HTTP 5xx after Payment was sent.
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
const fs = require('fs');
const path = require('path');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const queueService = require('../services/queueService');
const { enqueueAutoRouteIfNeeded } = require('../services/autoRouteService');
const { reversalService } = require('../src/Application/Services/ReversalService');
const { listUnresolvedProviderResults, classifyPaymentTransportError } = require('../services/providerDispatchClaimService');

jest.setTimeout(180000);

const AMOUNT = 100;
const CUSTOMER_BALANCE = 800;
const CUSTOMER_COST = 40;

let replSet;
let sequence = 0;
let paymentCalls = 0;
let inquiryMode = 'ok';
let paymentMode = 'success';
let releaseSecondPayment = () => {};
let secondPaymentEntered = Promise.resolve();

const successPaymentBody = () => ({
    data: {
        Code: 200,
        Message: 'عمليه ناجحه',
        Data: {
            TransactionNumber: '50011611',
            RefTransactionNumber: '28059087',
            Amount: AMOUNT,
            BalanceBefore: 5000,
            BalanceAfter: 4900,
            Status: 'عمليه ناجحه',
            IsPaid: 1,
            IsFailure: 0
        }
    }
});

const throwPaymentError = (mode) => {
    if (mode === 'timeout') {
        const error = new Error('timeout of 180000ms exceeded');
        error.code = 'ECONNABORTED';
        throw error;
    }
    if (mode === 'reset') {
        const error = new Error('socket hang up');
        error.code = 'ECONNRESET';
        error.request = {};
        throw error;
    }
    if (mode === 'http5xx') {
        const error = new Error('Request failed with status code 500');
        error.code = 'ERR_BAD_RESPONSE';
        error.response = { status: 500, data: { Message: 'provider unavailable' } };
        throw error;
    }
    if (mode === 'refused') {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
        error.code = 'ECONNREFUSED';
        throw error;
    }
    return null;
};

const armProvider = () => {
    paymentCalls = 0;
    secondPaymentEntered = new Promise((resolve) => {
        releaseSecondPayment = resolve;
    });
    axios.post.mockImplementation(async (url) => {
        const target = String(url);
        if (target.includes('/Account/GetBalance')) {
            return {
                data: {
                    Code: 200,
                    Data: { ServiceCredit: 5000, CashCredit: 0, AvailableBalance: 5000 }
                }
            };
        }
        if (target.includes('/Transactions/Inquiry')) {
            if (inquiryMode === 'dns') {
                const error = new Error('getaddrinfo ENOTFOUND provider.test');
                error.code = 'ENOTFOUND';
                throw error;
            }
            if (inquiryMode === 'refused') {
                const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
                error.code = 'ECONNREFUSED';
                throw error;
            }
            if (inquiryMode === 'gate') {
                return { data: { Code: 422, Message: 'تم رفض الاستعلام', Data: null } };
            }
            return { data: { Code: 200, Data: { PaymentBillInfo: 'bill-info' } } };
        }
        if (target.includes('/Transactions/Payment')) {
            paymentCalls += 1;
            if (paymentCalls >= 2) releaseSecondPayment();
            if (paymentMode === 'concurrent') {
                if (paymentCalls < 2) {
                    await Promise.race([
                        secondPaymentEntered,
                        new Promise((resolve) => setTimeout(resolve, 400))
                    ]);
                }
            }
            const thrown = throwPaymentError(paymentMode);
            if (thrown) throw thrown;
            return successPaymentBody();
        }
        throw new Error(`unexpected provider url ${target}`);
    });
};

const expectChecks = (checks) => {
    const problems = checks
        .filter((item) => !item.ok)
        .map((item) => `${item.name}: expected ${JSON.stringify(item.expected)} got ${JSON.stringify(item.actual)}`);
    expect(problems).toEqual([]);
};

const createFixture = async ({ phone = '01099887766' } = {}) => {
    sequence += 1;
    const user = await User.create({
        name: 'عميل التجربة',
        phone: `010${String(10000000 + sequence)}`,
        webUsername: `customer-${sequence}@example.com`,
        webPassword: 'hashed-password',
        balance: CUSTOMER_BALANCE,
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
        customId: `ATT-UNRESOLVED-${sequence}`,
        userId: user.phone,
        companyName: 'عميل فردي',
        employeeName: 'عميل التجربة',
        transferType: 'vodafone',
        vodafoneNumber: phone,
        amount: AMOUNT,
        costLYD: CUSTOMER_COST,
        status: 'processing',
        executorGroupId: executor._id,
        executorName: executor.name
    });
    return { user, executor, tx };
};

const reload = (tx) => Transaction.findById(tx._id);

const executorDebits = (executor) => Ledger.find({
    entityId: executor._id,
    entityModel: 'ExecutorGroup',
    type: 'TRANSFER',
    amount: { $lt: 0 }
}).lean();

const customerRefunds = () => Ledger.find({ type: { $in: ['REFUND', 'REVERSAL'] } }).lean();

const crashTransactionSaves = async (fn) => {
    const original = Transaction.prototype.save;
    Transaction.prototype.save = async function simulatedCrash() {
        throw new Error('SIMULATED_PROCESS_CRASH_BEFORE_SAVE');
    };
    try {
        await fn();
    } finally {
        Transaction.prototype.save = original;
    }
};

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' }
    });
    await mongoose.connect(replSet.getUri(), { serverSelectionTimeoutMS: 20000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName) throw new Error('MongoDB transactions require a replica set');
});

afterAll(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
});

afterEach(async () => {
    inquiryMode = 'ok';
    paymentMode = 'success';
    queueService.queue.length = 0;
    queueService.isProcessing = false;
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

describe('provider dispatch defects', () => {
    test('defect 1: crash after Payment success before save does not pay or debit again', async () => {
        armProvider();
        paymentMode = 'success';
        const { user, executor, tx } = await createFixture();

        await crashTransactionSaves(() => queueService.processSingleJob(String(tx._id), String(executor._id)));
        await queueService.processSingleJob(String(tx._id), String(executor._id));

        const stored = await reload(tx);
        const debits = await executorDebits(executor);
        const refunds = await customerRefunds();
        const customer = await User.findById(user._id).lean();
        const flagged = stored.apiResultData?.providerResultUnresolved === true;

        expectChecks([
            { name: 'paymentCalls', ok: paymentCalls === 1, expected: 1, actual: paymentCalls },
            { name: 'executorDebits', ok: debits.length <= 1, expected: 'at most 1', actual: debits.length },
            { name: 'notTwoDebits', ok: debits.length !== 2, expected: 'never 2', actual: debits.length },
            {
                name: 'rowFlaggedOrCompleted',
                ok: stored.status === 'completed' || (stored.status === 'processing' && flagged),
                expected: 'completed or processing+flagged',
                actual: { status: stored.status, flagged }
            },
            { name: 'customerRefunds', ok: refunds.length === 0, expected: 0, actual: refunds.length },
            {
                name: 'customerBalance',
                ok: customer.balance === CUSTOMER_BALANCE,
                expected: CUSTOMER_BALANCE,
                actual: customer.balance
            }
        ]);
    });

    test('defect 1: two concurrent jobs send one Payment', async () => {
        armProvider();
        paymentMode = 'concurrent';
        const { executor, tx } = await createFixture();

        await Promise.all([
            queueService.processSingleJobSerialized(String(tx._id), String(executor._id)),
            queueService.processSingleJobSerialized(String(tx._id), String(executor._id))
        ]);

        const stored = await reload(tx);
        const debits = await executorDebits(executor);
        const flagged = stored.apiResultData?.providerResultUnresolved === true;

        expectChecks([
            { name: 'paymentCalls', ok: paymentCalls === 1, expected: 1, actual: paymentCalls },
            { name: 'executorDebits', ok: debits.length <= 1, expected: 'at most 1', actual: debits.length },
            {
                name: 'rowFlaggedOrCompleted',
                ok: stored.status === 'completed' || (stored.status === 'processing' && flagged),
                expected: 'completed or processing+flagged',
                actual: { status: stored.status, flagged, debits: debits.length }
            }
        ]);
    });

    test.each([
        ['timeout', 'timeout'],
        ['reset', 'reset'],
        ['http5xx', 'http5xx']
    ])('defect 2: %s after Payment was sent does not repay, debit, or refund', async (_label, mode) => {
        armProvider();
        paymentMode = mode;
        const { user, executor, tx } = await createFixture();

        await queueService.processSingleJob(String(tx._id), String(executor._id));
        const afterFirst = await reload(tx);
        await queueService.processSingleJob(String(tx._id), String(executor._id));
        const route = await enqueueAutoRouteIfNeeded(afterFirst, executor);
        let cancel = { success: true, code: null, message: '' };
        for (let attempt = 0; attempt < 4; attempt += 1) {
            cancel = await reversalService.reverseTransaction(
                String(tx._id),
                'محاولة إلغاء مع استرجاع',
                'مشرف التجربة',
                { status: 'cancelled_by_admin' }
            );
            const locked = String(cancel.message || '').includes('IX lock');
            if (!locked) break;
            await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
        }

        const stored = await reload(tx);
        const debits = await executorDebits(executor);
        const refunds = await customerRefunds();
        const customer = await User.findById(user._id).lean();

        expectChecks([
            { name: 'paymentCalls', ok: paymentCalls === 1, expected: 1, actual: paymentCalls },
            { name: 'executorDebits', ok: debits.length === 0, expected: 0, actual: debits.length },
            { name: 'customerRefunds', ok: refunds.length === 0, expected: 0, actual: refunds.length },
            { name: 'status', ok: stored.status === 'processing', expected: 'processing', actual: stored.status },
            {
                name: 'executorKept',
                ok: String(stored.executorGroupId || '') === String(executor._id),
                expected: String(executor._id),
                actual: stored.executorGroupId ? String(stored.executorGroupId) : null
            },
            {
                name: 'flagged',
                ok: stored.apiResultData?.providerResultUnresolved === true,
                expected: true,
                actual: stored.apiResultData?.providerResultUnresolved === true
            },
            {
                name: 'unresolvedCode',
                ok: stored.apiResultData?.providerResultUnresolvedCode === 'PROVIDER_RESULT_UNRESOLVED',
                expected: 'PROVIDER_RESULT_UNRESOLVED',
                actual: stored.apiResultData?.providerResultUnresolvedCode || null
            },
            {
                name: 'adminNote',
                ok: String(stored.adminNotes || '').includes('PROVIDER_RESULT_UNRESOLVED'),
                expected: 'admin note contains PROVIDER_RESULT_UNRESOLVED',
                actual: stored.adminNotes || ''
            },
            { name: 'autoRouteQueued', ok: route.queued === false, expected: false, actual: route.queued },
            { name: 'cancelRefused', ok: cancel.success === false, expected: false, actual: cancel.success },
            {
                name: 'cancelCode',
                ok: cancel.code === 'PROVIDER_RESULT_UNRESOLVED',
                expected: 'PROVIDER_RESULT_UNRESOLVED',
                actual: { code: cancel.code || null, message: cancel.message || '' }
            },
            {
                name: 'customerBalance',
                ok: customer.balance === CUSTOMER_BALANCE,
                expected: CUSTOMER_BALANCE,
                actual: customer.balance
            }
        ]);
    });

    test('error before Payment is sent keeps pending and does not call Payment', async () => {
        armProvider();
        inquiryMode = 'dns';
        paymentMode = 'success';
        const { user, executor, tx } = await createFixture();

        await queueService.processSingleJob(String(tx._id), String(executor._id));

        const stored = await reload(tx);
        const debits = await executorDebits(executor);
        const refunds = await customerRefunds();
        const customer = await User.findById(user._id).lean();

        expectChecks([
            { name: 'paymentCalls', ok: paymentCalls === 0, expected: 0, actual: paymentCalls },
            { name: 'status', ok: stored.status === 'pending', expected: 'pending', actual: stored.status },
            {
                name: 'executorCleared',
                ok: !stored.executorGroupId,
                expected: null,
                actual: stored.executorGroupId ? String(stored.executorGroupId) : null
            },
            {
                name: 'notFlagged',
                ok: stored.apiResultData?.providerResultUnresolved !== true,
                expected: false,
                actual: stored.apiResultData?.providerResultUnresolved === true
            },
            { name: 'executorDebits', ok: debits.length === 0, expected: 0, actual: debits.length },
            { name: 'customerRefunds', ok: refunds.length === 0, expected: 0, actual: refunds.length },
            {
                name: 'customerBalance',
                ok: customer.balance === CUSTOMER_BALANCE,
                expected: CUSTOMER_BALANCE,
                actual: customer.balance
            },
            {
                name: 'failureNote',
                ok: String(stored.adminNotes || '').includes('فشل التنفيذ الآلي'),
                expected: 'existing failure note',
                actual: stored.adminNotes || ''
            }
        ]);
    });

    test('normal success still sends one Payment and one executor debit', async () => {
        armProvider();
        paymentMode = 'success';
        const { user, executor, tx } = await createFixture();

        await queueService.processSingleJob(String(tx._id), String(executor._id));

        const stored = await reload(tx);
        const debits = await executorDebits(executor);
        const refunds = await customerRefunds();
        const customer = await User.findById(user._id).lean();
        const executorAfter = await ExecutorGroup.findById(executor._id).lean();

        expectChecks([
            { name: 'paymentCalls', ok: paymentCalls === 1, expected: 1, actual: paymentCalls },
            { name: 'executorDebits', ok: debits.length === 1, expected: 1, actual: debits.length },
            {
                name: 'debitAmount',
                ok: debits[0] && debits[0].amount === -AMOUNT,
                expected: -AMOUNT,
                actual: debits[0] ? debits[0].amount : null
            },
            {
                name: 'debitType',
                ok: debits[0] && debits[0].type === 'TRANSFER',
                expected: 'TRANSFER',
                actual: debits[0] ? debits[0].type : null
            },
            {
                name: 'debitDescription',
                ok: debits[0] && debits[0].description === 'تنفيذ API آلي',
                expected: 'تنفيذ API آلي',
                actual: debits[0] ? debits[0].description : null
            },
            {
                name: 'debitAccount',
                ok: debits[0] && String(debits[0].entityId) === String(executor._id),
                expected: String(executor._id),
                actual: debits[0] ? String(debits[0].entityId) : null
            },
            { name: 'status', ok: stored.status === 'completed', expected: 'completed', actual: stored.status },
            {
                name: 'executorBalance',
                ok: executorAfter.balance === 50000 - AMOUNT,
                expected: 50000 - AMOUNT,
                actual: executorAfter.balance
            },
            { name: 'customerRefunds', ok: refunds.length === 0, expected: 0, actual: refunds.length },
            {
                name: 'customerBalance',
                ok: customer.balance === CUSTOMER_BALANCE,
                expected: CUSTOMER_BALANCE,
                actual: customer.balance
            }
        ]);
    });

    test('connection refused before Payment is accepted keeps pending and allows one later success', async () => {
        armProvider();
        paymentMode = 'refused';
        const { executor, tx } = await createFixture();

        await queueService.processSingleJob(String(tx._id), String(executor._id));
        const afterRefusal = await reload(tx);
        const statusAfterRefusal = afterRefusal.status;
        const flaggedAfterRefusal = afterRefusal.apiResultData?.providerResultUnresolved === true;
        afterRefusal.status = 'processing';
        afterRefusal.executorGroupId = executor._id;
        afterRefusal.executorName = executor.name;
        await afterRefusal.save();
        paymentMode = 'success';
        await queueService.processSingleJob(String(tx._id), String(executor._id));

        const stored = await reload(tx);
        const debits = await executorDebits(executor);

        expectChecks([
            {
                name: 'firstStatus',
                ok: statusAfterRefusal === 'pending',
                expected: 'pending',
                actual: statusAfterRefusal
            },
            {
                name: 'firstNotFlagged',
                ok: flaggedAfterRefusal === false,
                expected: false,
                actual: flaggedAfterRefusal
            },
            { name: 'paymentCalls', ok: paymentCalls === 2, expected: 2, actual: paymentCalls },
            { name: 'status', ok: stored.status === 'completed', expected: 'completed', actual: stored.status },
            { name: 'executorDebits', ok: debits.length === 1, expected: 1, actual: debits.length }
        ]);
    });

    test('read-only listing returns flagged rows and dispatch markers without a result', async () => {
        const executor = await ExecutorGroup.create({
            name: 'List Executor',
            status: 'active',
            balance: 1000,
            isApiBot: true,
            serviceKey: 'vodafone'
        });
        await Transaction.create({
            customId: 'ATT-LIST-FLAGGED',
            amount: 10,
            status: 'processing',
            executorGroupId: executor._id,
            executorName: executor.name,
            apiResultData: {
                providerDispatchStartedAt: new Date(),
                providerDispatchAttemptId: 'attempt-flagged',
                providerResultUnresolved: true,
                providerResultUnresolvedCode: 'PROVIDER_RESULT_UNRESOLVED'
            }
        });
        await Transaction.create({
            customId: 'ATT-LIST-MARKER',
            amount: 11,
            status: 'processing',
            executorGroupId: executor._id,
            apiResultData: {
                providerDispatchStartedAt: new Date(),
                providerDispatchAttemptId: 'attempt-open'
            }
        });
        await Transaction.create({
            customId: 'ATT-LIST-DONE',
            amount: 12,
            status: 'completed',
            executorGroupId: executor._id,
            apiResultData: {
                providerDispatchStartedAt: new Date(),
                providerDispatchAttemptId: 'attempt-done',
                providerDispatchResult: 'accepted',
                referenceNumber: 'REF-DONE'
            }
        });

        const listing = await listUnresolvedProviderResults({ limit: 50 });
        const ids = listing.rows.map((row) => row.customId).sort();
        const script = fs.readFileSync(
            path.join(__dirname, '../scripts/listUnresolvedProviderResults.js'),
            'utf8'
        );

        expect(listing.count).toBe(2);
        expect(ids).toEqual(['ATT-LIST-FLAGGED', 'ATT-LIST-MARKER']);
        expect(script).not.toMatch(/updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|bulkWrite|replaceOne|findOneAndDelete|\.save\(/);
        expect(script).toMatch(/countDocuments/);
        expect(script).toMatch(/\.find\(/);
    });

    test('classifies transport failures before and after Payment may have been sent', () => {
        expect(classifyPaymentTransportError({ code: 'ENOTFOUND' })).toBe('before_send');
        expect(classifyPaymentTransportError({ code: 'ECONNREFUSED' })).toBe('before_send');
        expect(classifyPaymentTransportError({ code: 'ECONNABORTED' })).toBe('unresolved');
        expect(classifyPaymentTransportError({ code: 'ECONNRESET', request: {} })).toBe('unresolved');
        expect(classifyPaymentTransportError({ response: { status: 500 } })).toBe('unresolved');
        expect(classifyPaymentTransportError({ response: { status: 422 } })).toBe('definitive_rejection');
        expect(classifyPaymentTransportError(new Error('unknown'))).toBe('unresolved');
    });
});
