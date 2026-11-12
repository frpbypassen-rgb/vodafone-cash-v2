'use strict';

jest.mock('../services/zaynpayApi', () => ({ inquiry: jest.fn(), pay: jest.fn() }));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));
jest.mock('../services/lockService', () => ({ acquireLock: jest.fn(async () => ({ release: async () => {} })), releaseLock: jest.fn(async () => {}) }));
jest.mock('../utils/manualExecutorReceipt', () => ({ generateManualExecutorReceiptBase64: jest.fn(async () => 'receipt'), generateExecutorReceiptBase64: jest.fn(() => 'receipt') }));
jest.mock('../services/executorProofStorageService', () => ({ saveProviderReceiptProof: jest.fn(() => 'proofs/provider-test.png') }));
jest.mock('../services/proofStorageService', () => ({ saveProofImage: jest.fn(() => 'proofs/provider-test.png') }));
let mockWalletTail = Promise.resolve();
jest.mock('../services/walletService', () => {
    const actual = jest.requireActual('../services/walletService');
    return { ...actual, updateBalanceWithLedger: jest.fn(async (...args) => {
        const previous = mockWalletTail;
        let release;
        mockWalletTail = new Promise(resolve => { release = resolve; });
        await previous;
        try { return await actual.updateBalanceWithLedger(...args); }
        finally { release(); }
    }) };
});
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const provider = require('../services/zaynpayApi');
const eventBus = require('../services/eventBus');
const { executeZaynPayIdempotent } = require('../services/mobileWebParityService');
const { executeExecutorProviderTask } = require('../services/executorProviderExecutionService');
const { completeApiTransactionWithReference } = require('../services/apiExecutionLifecycleService');
let replica;
beforeAll(async () => {
    process.env.EXTERNAL_API_ENABLED = 'true';
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all([Employee.init(), ExecutorGroup.init(), Transaction.init(), Ledger.init()]);
});
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockWalletTail = Promise.resolve();
    await Promise.all([Employee.deleteMany({}), ExecutorGroup.deleteMany({}), Transaction.deleteMany({}), Ledger.deleteMany({})]);
    provider.inquiry.mockResolvedValue('bill');
    provider.pay.mockResolvedValue({ success: true, refNumber: '010****123', transactionNumber: 'provider-1' });
    eventBus.publish.mockImplementation(() => {});
});
async function fixture(status = 'accepted') {
    const group = await ExecutorGroup.create({ name: 'Isolated API executor', balance: 1000 });
    const employee = await Employee.create({ name: 'Provider operator', role: 'operator', status: 'active', groupId: group._id, webUsername: 'zaynapi@ahram.com', webPassword: 'test-only-password' });
    const tx = await Transaction.create({ customId: 'PROVIDER-AUDIT-1', status, amount: 100, costLYD: 20, operatorId: employee.id, executorGroupId: group._id, vodafoneNumber: '01012345678', transferType: 'vodafone' });
    const req = { method: 'POST', baseUrl: '/api/mobile', path: `/executor/tasks/${tx.id}/zaynpay-execute`, user: { userId: employee.id }, headers: { 'idempotency-key': 'provider-key-1' }, body: {} };
    return { group, employee, tx, req };
}

test('a lost mobile Payment reply blocks later mobile and web payment attempts', async () => {
    const { employee, tx, req } = await fixture();
    provider.pay.mockRejectedValue(new Error('connection lost after provider acceptance'));
    await executeZaynPayIdempotent({ executorId: employee.id, taskId: tx.id, req }).catch(() => {});
    req.headers['idempotency-key'] = 'provider-key-2';
    await executeZaynPayIdempotent({ executorId: employee.id, taskId: tx.id, req }).catch(() => {});
    await executeExecutorProviderTask({ executorId: employee.id, transactionId: tx.id }).catch(() => {});
    expect(provider.pay).toHaveBeenCalledTimes(1);
    expect((await Transaction.findById(tx._id)).apiResultData.providerResultUnresolved).toBe(true);
});

test('simultaneous web and mobile execution shares a durable payment claim', async () => {
    const { group, employee, tx, req } = await fixture();
    let inquiries = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    provider.inquiry.mockImplementation(async () => { if (++inquiries === 2) release(); await gate; return 'bill'; });
    await Promise.allSettled([
        executeZaynPayIdempotent({ executorId: employee.id, taskId: tx.id, req }),
        executeExecutorProviderTask({ executorId: employee.id, transactionId: tx.id })
    ]);
    expect(provider.pay).toHaveBeenCalledTimes(1);
    expect((await ExecutorGroup.findById(group._id)).balance).toBe(900);
});

test('successful mobile execution survives notification failure and replays its response', async () => {
    const { group, employee, tx, req } = await fixture();
    eventBus.publish.mockImplementation(() => { throw new Error('notification unavailable'); });
    const first = await executeZaynPayIdempotent({ executorId: employee.id, taskId: tx.id, req });
    const replay = await executeZaynPayIdempotent({ executorId: employee.id, taskId: tx.id, req });
    expect(first.response).toEqual(replay.response);
    expect(replay.replayed).toBe(true);
    expect(provider.pay).toHaveBeenCalledTimes(1);
    expect((await ExecutorGroup.findById(group._id)).balance).toBe(900);
});

test('an unresolved legacy row cannot submit Payment from the web', async () => {
    const { employee, tx } = await fixture();
    await Transaction.updateOne({ _id: tx._id }, { $set: { 'apiResultData.providerResultUnresolved': true } });
    await executeExecutorProviderTask({ executorId: employee.id, transactionId: tx.id }).catch(() => {});
    expect(provider.pay).not.toHaveBeenCalled();
});

test('failure saving API completion rolls back the executor debit and ledger together', async () => {
    const { group, tx } = await fixture('processing');
    jest.spyOn(Transaction.prototype, 'save').mockRejectedValueOnce(new Error('AUDIT_COMPLETION_SAVE_FAILED'));
    await expect(completeApiTransactionWithReference({ tx, executorGroup: group, apiResult: { reference_number: '010****123' } })).rejects.toThrow('AUDIT_COMPLETION_SAVE_FAILED');
    expect((await ExecutorGroup.findById(group._id)).balance).toBe(1000);
    expect(await Ledger.countDocuments()).toBe(0);
    expect((await Transaction.findById(tx._id)).status).toBe('processing');
});

test('concurrent API completion posts one executor debit', async () => {
    const { group, tx } = await fixture('processing');
    const copies = await Promise.all([Transaction.findById(tx._id), Transaction.findById(tx._id)]);
    await Promise.all(copies.map(copy => completeApiTransactionWithReference({ tx: copy, executorGroup: group, apiResult: { reference_number: '010****123' } })));
    expect((await ExecutorGroup.findById(group._id)).balance).toBe(900);
    expect(await Ledger.countDocuments({ transactionId: tx.customId })).toBe(1);
    expect((await Transaction.findById(tx._id)).status).toBe('completed');
});

const dispatch = require('../services/providerDispatchClaimService');
test('a settled provider result cannot acquire another dispatch even when legacy markers are missing', async () => {
    const { tx } = await fixture('processing');
    await Transaction.updateOne({ _id: tx._id }, { $set: { 'apiResultData.providerDispatchResult': 'accepted' } });
    expect((await dispatch.claimProviderDispatch(tx)).claimed).toBe(false);
});
test('a stale release cannot clear the local claim after ownership changes', async () => {
    const { tx } = await fixture('processing');
    const claim = await dispatch.claimProviderDispatch(tx);
    await Transaction.updateOne({ _id: tx._id }, { $set: { status: 'completed' } });
    await expect(dispatch.releaseProviderDispatchClaim(tx, claim.attemptId)).rejects.toThrow('PROVIDER_DISPATCH_RELEASE_CONFLICT');
    expect(tx.apiResultData.providerDispatchAttemptId).toBe(claim.attemptId);
});
test('reviewed not-paid work can be reassigned and redispatched while preserving its resolution history', async () => {
    const { tx } = await fixture('accepted');
    tx.apiResultData = { providerResolutionOutcome: 'provider_not_paid', providerResolutionEvidence: 'review-1', providerDispatchResult: 'rejected', providerResultUnresolved: false };
    await tx.save();
    expect(dispatch.automaticPaymentBlocked(tx)).toBe(false);
    expect((await dispatch.claimProviderDispatch(tx, { expectedStatus: 'accepted' })).claimed).toBe(true);
    const row = await Transaction.findById(tx._id);
    expect(row.apiResultData.providerResolutionOutcome).toBeUndefined();
    expect(row.apiResultData.providerDispatchResult).toBeUndefined();
    await dispatch.markProviderResultUnresolved({ txId: tx._id, reason: 'lost new reply', source: 'audit' });
    expect((await Transaction.findById(tx._id)).apiResultData.providerResultUnresolved).toBe(true);
    expect(row.apiResultData.providerResolutionHistory[0].providerResolutionEvidence).toBe('review-1');
});

test.each(['suspended', 'insufficient_balance', 'invalid_amount'])('web preflight refuses %s before sending Payment', async scenario => {
    const { employee, group, tx } = await fixture();
    if (scenario === 'suspended') await Employee.updateOne({ _id: employee._id }, { $set: { status: 'suspended' } });
    if (scenario === 'insufficient_balance') await ExecutorGroup.updateOne({ _id: group._id }, { $set: { balance: 1 } });
    if (scenario === 'invalid_amount') await Transaction.updateOne({ _id: tx._id }, { $set: { amount: 0 } });
    await expect(executeExecutorProviderTask({ executorId: employee.id, transactionId: tx.id })).rejects.toThrow();
    expect(provider.pay).not.toHaveBeenCalled();
});

test('mobile never substitutes its local operation id for a missing provider reference', async () => {
    const { group, employee, tx, req } = await fixture();
    provider.pay.mockResolvedValue({ success: true });
    await expect(executeZaynPayIdempotent({ executorId: employee.id, taskId: tx.id, req })).rejects.toThrow('PROVIDER_RESULT_UNRESOLVED');
    expect((await Transaction.findById(tx._id)).status).toBe('processing');
    expect((await ExecutorGroup.findById(group._id)).balance).toBe(1000);
});

test('32 competing mobile and web requests send and debit the same operation once', async () => {
    const { employee, group, tx, req } = await fixture();
    const count = 32;
    let inquiries = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    provider.inquiry.mockImplementation(async () => { if (++inquiries === count) release(); await gate; return 'bill'; });
    const outcomes = await Promise.allSettled(Array.from({ length: count }, (_, index) => index % 2
        ? executeExecutorProviderTask({ executorId: employee.id, transactionId: tx.id })
        : executeZaynPayIdempotent({ executorId: employee.id, taskId: tx.id, req: {
            ...req, headers: { 'idempotency-key': 'parallel-key-' + index }
        } })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(provider.pay).toHaveBeenCalledTimes(1);
    expect((await ExecutorGroup.findById(group._id)).balance).toBe(900);
    expect((await Transaction.findById(tx._id)).status).toBe('completed');
});
