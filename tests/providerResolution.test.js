'use strict';

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

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const User = require('../models/User');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const Ledger = require('../models/Ledger');
const AuditLog = require('../models/AuditLog');
const queueService = require('../services/queueService');
const { enqueueAutoRouteIfNeeded } = require('../services/autoRouteService');
const { addTransferJob } = require('../services/bullQueueService');
const { reversalService } = require('../src/Application/Services/ReversalService');
const { cancelTransfer } = require('../services/transferService');
const { postCancelTask, postReturnTask } = require('../controllers/executorTransactionController');
const { returnTask } = require('../services/mobileWebParityService');
const { resolveProviderResult } = require('../services/providerResolutionService');
const adminTransactions = require('../routes/adminTransactions');

jest.setTimeout(180000);

const AMOUNT = 100;
const CUSTOMER_BALANCE = 800;
let replSet;
let sequence = 0;
let paymentCalls = 0;

axios.post = jest.fn(async (url) => {
    if (String(url).includes('/Transactions/Payment')) paymentCalls += 1;
    throw new Error(`unexpected provider call ${url}`);
});

const moneySnapshot = async (executorId) => {
    const debits = await Ledger.find({
        entityId: executorId,
        entityModel: 'ExecutorGroup',
        type: 'TRANSFER',
        amount: { $lt: 0 }
    }).lean();
    const refunds = await Ledger.find({ type: { $in: ['REFUND', 'REVERSAL'] } }).lean();
    return { debits: debits.length, refunds: refunds.length, paymentCalls };
};

const createHeldTransfer = async ({ status = 'processing' } = {}) => {
    sequence += 1;
    const user = await User.create({
        name: 'عميل الحسم',
        phone: `011${String(10000000 + sequence)}`,
        webUsername: `held-${sequence}@example.com`,
        webPassword: 'hashed-password',
        balance: CUSTOMER_BALANCE,
        status: 'active'
    });
    const executor = await ExecutorGroup.create({
        name: `Held Executor ${sequence}`,
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
        customId: `ATT-HOLD-${sequence}`,
        userId: user.phone,
        companyName: 'عميل فردي',
        employeeName: 'عميل الحسم',
        transferType: 'vodafone',
        vodafoneNumber: '01099887766',
        amount: AMOUNT,
        costLYD: 40,
        status,
        executorGroupId: executor._id,
        executorName: executor.name,
        apiResultData: {
            providerDispatchStartedAt: new Date(),
            providerDispatchAttemptId: `attempt-${sequence}`,
            providerDispatchExecutorGroupId: executor._id,
            providerDispatchResult: 'pending_reference',
            providerResultUnresolved: true,
            providerResultUnresolvedAt: new Date(),
            providerResultUnresolvedReason: 'provider accepted without a reference number',
            providerResultUnresolvedCode: 'PROVIDER_RESULT_UNRESOLVED'
        }
    });
    return { user, executor, tx };
};

const invokeJson = (handler, req) => new Promise((resolve) => {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; resolve(this); return this; }
    };
    Promise.resolve(handler(req, res)).catch((error) => {
        resolve({ statusCode: 500, body: { error: error.message } });
    });
});

const adminApp = () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = {
            isLoggedIn: true,
            adminId: 'admin-resolver',
            adminName: 'مراجع المزود',
            adminRole: 'admin',
            adminPermissions: ['transactions.resolve_provider']
        };
        next();
    });
    app.use(adminTransactions);
    return app;
};

const reverseUntilCode = async (txId) => {
    let result = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        result = await reversalService.reverseTransaction(txId, 'محاولة إلغاء مع استرجاع', 'مشرف التجربة');
        if (!String(result.message || '').includes('IX lock')) return result;
    }
    return result;
};

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' }
    });
    await mongoose.connect(replSet.getUri(), { serverSelectionTimeoutMS: 20000 });
});

afterAll(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
});

afterEach(async () => {
    paymentCalls = 0;
    const collections = await mongoose.connection.db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

describe('pending_reference money hold', () => {
    test('blocks refund, return, pull, assign, auto-route, and queue re-send', async () => {
        const { user, executor, tx } = await createHeldTransfer();
        const before = await moneySnapshot(executor._id);
        const statusBefore = tx.status;

        const reversal = await reverseUntilCode(String(tx._id));
        const cancel = await cancelTransfer({
            taskId: String(tx._id),
            userId: 'missing-employee',
            reason: 'إلغاء منفذ'
        });
        const executorCancel = await invokeJson(postCancelTask, {
            params: { id: String(tx._id) },
            body: { reason: 'إلغاء مباشر' },
            session: {}
        });
        const executorReturn = await invokeJson(postReturnTask, {
            params: { id: String(tx._id) },
            body: { reason: 'إرجاع' },
            session: {}
        });
        const employee = await Employee.create({
            name: 'منفذ',
            role: 'operator',
            status: 'active',
            groupId: executor._id,
            webUsername: `executor-${sequence}@example.com`,
            webPassword: 'hashed-password'
        });
        let mobileReturnCode = null;
        try {
            await returnTask({ executorId: employee._id, taskId: String(tx._id), reason: 'إرجاع موبايل' });
        } catch (error) {
            mobileReturnCode = error.code || error.message;
        }

        const app = adminApp();
        const pull = await request(app)
            .post(`/transaction/${tx._id}/pull-task`)
            .set('Accept', 'application/json');
        const assign = await request(app)
            .post(`/transaction/${tx._id}/assign-executor`)
            .set('Accept', 'application/json')
            .send({ executorGroupId: String(executor._id) });
        const globalCancel = await request(app)
            .post(`/transaction/${tx._id}/global-cancel`)
            .set('Accept', 'application/json')
            .send({ reason: 'إلغاء إداري' });
        const route = await enqueueAutoRouteIfNeeded(await Transaction.findById(tx._id), executor);
        const queued = await addTransferJob(String(tx._id), String(executor._id));
        const job = await queueService.processSingleJob(String(tx._id), String(executor._id));

        const stored = await Transaction.findById(tx._id);
        const refreshedUser = await User.findById(user._id);
        const after = await moneySnapshot(executor._id);

        expect(reversal.success).toBe(false);
        expect(reversal.statusCode).toBe(409);
        expect(reversal.code).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect({
            success: cancel.success,
            statusCode: cancel.statusCode,
            code: cancel.code,
            message: cancel.message
        }).toMatchObject({
            success: false,
            statusCode: 409,
            code: 'PROVIDER_RESULT_UNRESOLVED'
        });
        expect(executorCancel.statusCode).toBe(409);
        expect(executorCancel.body.code).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect(executorReturn.statusCode).toBe(409);
        expect(executorReturn.body.code).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect(mobileReturnCode).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect(pull.status).toBe(409);
        expect(pull.body.code).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect(assign.status).toBe(409);
        expect(assign.body.code).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect(globalCancel.status).toBe(409);
        expect(globalCancel.body.code).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect(route.queued).toBe(false);
        expect(route.code).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect(queued.queued).toBe(false);
        expect(job.skipped).toBe(true);
        expect(stored.status).toBe(statusBefore);
        expect(String(stored.executorGroupId)).toBe(String(executor._id));
        expect(after).toEqual(before);
        expect(after.paymentCalls).toBe(0);
        expect(after.debits).toBe(0);
        expect(after.refunds).toBe(0);
        expect(refreshedUser.balance).toBe(CUSTOMER_BALANCE);
    });
});

describe('manual provider resolution', () => {
    const evidence = 'PROV-TX-1001';
    const note = 'كشف المزود يؤكد هذه المحاولة';

    const resolver = async (permissions, role = 'admin') => {
        sequence += 1;
        return Admin.create({
            name: 'مراجع المزود',
            role,
            webUsername: `resolver-${sequence}@example.com`,
            webPassword: 'hashed-password',
            status: 'active',
            permissions
        });
    };

    const preview = (tx, admin, outcome) => resolveProviderResult({
        transactionId: String(tx._id),
        outcome,
        evidenceReference: evidence,
        note,
        confirm: false,
        actor: { id: admin._id, name: admin.name, role: admin.role, permissions: admin.permissions }
    });

    test('refuses missing evidence and missing permission without writing', async () => {
        const { tx } = await createHeldTransfer();
        const admin = await resolver(['transactions.manage']);
        const beforeAudit = await AuditLog.countDocuments();
        const beforeUpdated = tx.updatedAt.toISOString();

        const missingEvidence = await resolveProviderResult({
            transactionId: String(tx._id),
            outcome: 'provider_paid',
            evidenceReference: '   ',
            note: '',
            confirm: true,
            actor: { id: admin._id, name: admin.name, role: 'master', permissions: ['*'] }
        });
        const missingPermission = await resolveProviderResult({
            transactionId: String(tx._id),
            outcome: 'provider_paid',
            evidenceReference: evidence,
            note,
            confirm: true,
            expectedUpdatedAt: tx.updatedAt,
            actor: { id: admin._id, name: admin.name, role: admin.role, permissions: admin.permissions }
        });
        const stored = await Transaction.findById(tx._id);

        expect(missingEvidence.statusCode).toBe(400);
        expect(missingEvidence.code).toBe('EVIDENCE_REQUIRED');
        expect(missingPermission.statusCode).toBe(403);
        expect(missingPermission.code).toBe('PROVIDER_RESOLUTION_FORBIDDEN');
        expect(stored.updatedAt.toISOString()).toBe(beforeUpdated);
        expect(stored.status).toBe('processing');
        expect(await AuditLog.countDocuments()).toBe(beforeAudit);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('dry-run changes nothing and confirm paid posts one executor debit', async () => {
        const { user, executor, tx } = await createHeldTransfer();
        const admin = await resolver(['transactions.resolve_provider']);
        const dry = await preview(tx, admin, 'provider_paid');
        const afterDry = await Transaction.findById(tx._id);
        const auditsAfterDry = await AuditLog.countDocuments();

        expect(dry.dryRun).toBe(true);
        expect(dry.preview.providerPaymentCalls).toBe(0);
        expect(dry.preview.customerRefundLYD).toBe(0);
        expect(dry.preview.moneyMovements).toEqual([{
            entityModel: 'ExecutorGroup',
            entityId: String(executor._id),
            amount: -AMOUNT,
            type: 'TRANSFER',
            description: 'تنفيذ API آلي',
            apply: true
        }]);
        expect(afterDry.updatedAt.toISOString()).toBe(tx.updatedAt.toISOString());
        expect(afterDry.status).toBe('processing');
        expect(auditsAfterDry).toBe(0);

        const confirmed = await resolveProviderResult({
            transactionId: String(tx._id),
            outcome: 'provider_paid',
            evidenceReference: evidence,
            note,
            confirm: true,
            expectedUpdatedAt: dry.expectedUpdatedAt,
            actor: { id: admin._id, name: admin.name, role: admin.role, permissions: admin.permissions }
        });
        const again = await resolveProviderResult({
            transactionId: String(tx._id),
            outcome: 'provider_paid',
            evidenceReference: evidence,
            note,
            confirm: true,
            expectedUpdatedAt: dry.expectedUpdatedAt,
            actor: { id: admin._id, name: admin.name, role: admin.role, permissions: admin.permissions }
        });
        const stored = await Transaction.findById(tx._id);
        const debits = await Ledger.find({ type: 'TRANSFER', transactionId: tx.customId }).lean();
        const refunds = await Ledger.find({ type: { $in: ['REFUND', 'REVERSAL'] } }).lean();
        const audit = await AuditLog.findOne({ action: 'PROVIDER_RESULT_RESOLVED', targetId: tx._id }).lean();
        const refreshedUser = await User.findById(user._id);

        expect(confirmed.applied).toBe(true);
        expect(confirmed.statusAfter).toBe('completed');
        expect(again.applied).toBe(false);
        expect(stored.status).toBe('completed');
        expect(debits).toHaveLength(1);
        expect(debits[0].amount).toBe(-AMOUNT);
        expect(debits[0].description).toBe('تنفيذ API آلي');
        expect(debits[0].entityModel).toBe('ExecutorGroup');
        expect(refunds).toHaveLength(0);
        expect(paymentCalls).toBe(0);
        expect(refreshedUser.balance).toBe(CUSTOMER_BALANCE);
        expect(executor.balance - (await ExecutorGroup.findById(executor._id)).balance).toBe(AMOUNT);
        expect(audit).toBeTruthy();
        expect(String(audit.performedBy)).toBe(String(admin._id));
        expect(audit.metadata.evidenceReference).toBe(evidence);
        expect(audit.oldData.status).toBe('processing');
        expect(audit.newData.status).toBe('completed');
    });

    test('confirm not_paid follows the existing pending release once', async () => {
        const { executor, tx } = await createHeldTransfer();
        const admin = await resolver(['transactions.resolve_provider']);
        const dry = await preview(tx, admin, 'provider_not_paid');
        expect(dry.preview.moneyMovements).toEqual([]);
        expect(dry.preview.statusAfter).toBe('pending');
        expect(dry.preview.follows).toBe('releaseFailedApiExecutionToPending');

        const confirmed = await resolveProviderResult({
            transactionId: String(tx._id),
            outcome: 'provider_not_paid',
            evidenceReference: evidence,
            note,
            confirm: true,
            expectedUpdatedAt: dry.expectedUpdatedAt,
            actor: { id: admin._id, name: admin.name, role: admin.role, permissions: admin.permissions }
        });
        const again = await resolveProviderResult({
            transactionId: String(tx._id),
            outcome: 'provider_not_paid',
            evidenceReference: evidence,
            note,
            confirm: true,
            expectedUpdatedAt: dry.expectedUpdatedAt,
            actor: { id: admin._id, name: admin.name, role: admin.role, permissions: admin.permissions }
        });
        const stored = await Transaction.findById(tx._id);

        expect(confirmed.applied).toBe(true);
        expect(again.applied).toBe(false);
        expect(stored.status).toBe('pending');
        expect(stored.executorGroupId).toBeUndefined();
        expect(stored.apiResultData.providerResultUnresolved).toBe(false);
        expect(stored.apiResultData.providerDispatchResult).toBe('rejected');
        expect(stored.apiResultData.providerResolutionEvidence).toBe(evidence);
        expect(await Ledger.countDocuments()).toBe(0);
        expect(paymentCalls).toBe(0);
        expect(await AuditLog.countDocuments({ action: 'PROVIDER_RESULT_RESOLVED' })).toBe(1);
        expect((await ExecutorGroup.findById(executor._id)).balance).toBe(50000);
    });

    test('confirm fails when the row changed and concurrent confirms apply once', async () => {
        const changed = await createHeldTransfer();
        const raced = await createHeldTransfer();
        const admin = await resolver(['transactions.resolve_provider']);
        const dry = await preview(changed.tx, admin, 'provider_paid');
        await Transaction.updateOne({ _id: changed.tx._id }, { $set: { adminNotes: 'changed by someone else' } });
        const rejected = await resolveProviderResult({
            transactionId: String(changed.tx._id),
            outcome: 'provider_paid',
            evidenceReference: evidence,
            note,
            confirm: true,
            expectedUpdatedAt: dry.expectedUpdatedAt,
            actor: { id: admin._id, name: admin.name, role: admin.role, permissions: admin.permissions }
        });
        expect(rejected.code).toBe('ROW_CHANGED');
        expect((await Transaction.findById(changed.tx._id)).status).toBe('processing');
        expect(await Ledger.countDocuments({ transactionId: changed.tx.customId })).toBe(0);

        const racePreview = await preview(raced.tx, admin, 'provider_paid');
        const actor = { id: admin._id, name: admin.name, role: admin.role, permissions: admin.permissions };
        const [first, second] = await Promise.all([
            resolveProviderResult({
                transactionId: String(raced.tx._id),
                outcome: 'provider_paid',
                evidenceReference: evidence,
                note,
                confirm: true,
                expectedUpdatedAt: racePreview.expectedUpdatedAt,
                actor
            }),
            resolveProviderResult({
                transactionId: String(raced.tx._id),
                outcome: 'provider_paid',
                evidenceReference: evidence,
                note,
                confirm: true,
                expectedUpdatedAt: racePreview.expectedUpdatedAt,
                actor
            })
        ]);
        const appliedCount = [first, second].filter((item) => item.applied === true).length;
        const stored = await Transaction.findById(raced.tx._id);
        const debits = await Ledger.find({ transactionId: raced.tx.customId, type: 'TRANSFER' }).lean();

        expect(appliedCount).toBe(1);
        expect(stored.status).toBe('completed');
        expect(debits).toHaveLength(1);
        expect(paymentCalls).toBe(0);
    });

    test('resolution script dry-run does not call Payment or update the row', async () => {
        const { tx } = await createHeldTransfer();
        const admin = await resolver(['transactions.resolve_provider']);
        const script = fs.readFileSync(path.join(__dirname, '../scripts/resolveUnresolvedProviderResult.js'), 'utf8');
        expect(script).not.toMatch(/Transactions\/Payment|updateBalanceWithLedger|axios/);

        const output = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [
                path.join(__dirname, '../scripts/resolveUnresolvedProviderResult.js'),
                '--id', String(tx._id),
                '--outcome', 'provider_not_paid',
                '--evidence', evidence,
                '--note', note,
                '--actor-id', String(admin._id)
            ], {
                env: { ...process.env, MONGO_URI: replSet.getUri() },
                cwd: path.join(__dirname, '..')
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });

        const stored = await Transaction.findById(tx._id);
        expect(output.code).toBe(0);
        expect(output.stdout).toContain('"dryRun": true');
        expect(stored.status).toBe('processing');
        expect(stored.apiResultData.providerResultUnresolved).toBe(true);
        expect(paymentCalls).toBe(0);
        expect(await Ledger.countDocuments()).toBe(0);
    });
});
