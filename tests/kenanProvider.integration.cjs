'use strict';
// Run with node --test tests/kenanProvider.integration.cjs. A separate Node
// process avoids Jest's VM/Map serialization incompatibility with MongoDB 7.x.
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const eventBus = require('../services/eventBus');
const published = mock.method(eventBus, 'publish', () => {});
mock.method(require('../utils/manualExecutorReceipt'), 'generateExecutorReceiptBase64', () => 'data:image/jpeg;base64,YQ==');
mock.method(require('../services/proofStorageService'), 'saveProofImage', () => 'proofs/kenan-fixture.jpg');
mock.method(require('../services/auditService'), 'logAction', async () => {});
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Ledger = require('../models/Ledger');
const Settings = require('../models/Settings');
const api = require('../services/externalApiService');
const { pollPendingOrders } = require('../services/kenanProviderService');
const { completeDueApiTransactions } = require('../services/apiExecutionLifecycleService');
const { providerMoneyHold, automaticPaymentBlocked, claimProviderDispatch } = require('../services/providerDispatchClaimService');
let replSet, server, url, providerStatus, postCount;
before(async () => {
    process.env.APP_ENV = 'staging';
    process.env.EXTERNAL_API_ENABLED = 'true';
    process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
    process.env.KENAN_AUTO_FOLLOWUP_ENABLED = 'true';
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    // The shared Transaction schema declares duplicate named report indexes.
    // This isolated financial test needs only the transaction identity index.
    await mongoose.connect(replSet.getUri(), { dbName: 'kenan_integration_test', serverSelectionTimeoutMS: 10000, autoIndex: false });
    await Promise.all([Transaction.createCollection(), ExecutorGroup.createCollection(), Ledger.createCollection()]);
    await Transaction.collection.createIndex({ customId: 1 }, { unique: true });
    server = http.createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer fixture-key') { res.writeHead(401).end(); return; }
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST' && req.url === '/api/company/orders') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                const payload = JSON.parse(body);
                if ('amount_minor' in payload || !Number.isSafeInteger(payload.amount)) {
                    res.writeHead(400).end(JSON.stringify({ error: 'INTEGER_AMOUNT_IN_POUNDS_REQUIRED' })); return;
                }
                postCount += 1;
                if (providerStatus === 'create401' || providerStatus === 'create503') {
                    res.writeHead(providerStatus === 'create401' ? 401 : 503).end(JSON.stringify({message:'private fixture error'})); return;
                }
                res.end(JSON.stringify({ reference: '0000001', phone: payload.phone, amount_minor: payload.amount * 100, status: 'queued' }));
            });
        } else if (req.method === 'GET' && req.url === '/api/company/orders/0000001') {
            if (providerStatus === 'throttled') {
                res.writeHead(429, {'Retry-After':'180'}).end(JSON.stringify({message:'private upstream diagnostic'}));
                return;
            }
            res.end(JSON.stringify({ reference: '0000001', phone: '01000000000', amount_minor: 5000, fee_minor: 0, status: providerStatus,
                executor_phone: providerStatus === 'success' ? '01100000000' : null, completed_at: providerStatus === 'success' ? '2026-11-15T00:00:00Z' : null }));
        } else res.writeHead(404).end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
    mock.restoreAll();
});
beforeEach(() => { providerStatus = 'queued'; postCount = 0; published.mock.resetCalls(); });
const setupOrder = async (suffix, destination = {vodafoneNumber:'01000000000'}) => {
    const bot = await ExecutorGroup.create({ name: 'Kenan fixture', apiProviderKey: 'kenan', apiUrl: url, apiToken: 'fixture-key', isApiBot: true, balance: 1000 });
    const tx = await Transaction.create({ customId: 'KENAN-' + suffix, status: 'processing', executorGroupId: bot._id, transferType: 'vodafone', ...destination, amount: 50, costLYD: 10 });
    return {bot, tx};
};
const createOrder = async (suffix, destination) => {
    const {bot, tx} = await setupOrder(suffix, destination);
    const result = await api.executeTransferViaApi(tx, bot);
    assert.equal(result.success, 'pending');
    return { bot, tx };
};
const makeDue = tx => Transaction.updateOne({ _id: tx._id }, { $set: { 'apiResultData.kenanNextPollAt': new Date(0) } });
test('rejected and uncertain HTTP create replies persist without manufacturing receipt or resending', async () => {
    for (const status of [401,503]) {
        providerStatus = 'create'+status;
        const before = postCount;
        const {bot, tx} = await setupOrder('CREATE-'+status);
        const result = await api.executeTransferViaApi(tx,bot);
        assert.equal(result.success,status === 401 ? false : 'unresolved');
        const saved = await Transaction.findById(tx._id);
        assert.equal(saved.apiResultData.kenanCreateHttpStatus,status);
        assert.equal(saved.apiResultData.kenanCreateReplyState,status === 401 ? 'rejected' : 'unknown');
        assert.ok(saved.apiResultData.kenanCreateReplyAt instanceof Date);
        assert.equal(saved.apiResultData.kenanReference,undefined);
        assert.equal(JSON.stringify(saved.apiResultData).includes('private fixture error'),false);
        assert.equal(automaticPaymentBlocked(saved),status === 503);
        if (status === 503) assert.equal((await api.executeTransferViaApi(saved,bot)).success,'unresolved');
        await pollPendingOrders();
        assert.equal(postCount,before+1);
        assert.equal(await Ledger.countDocuments({transactionId:tx.customId}),0);
        assert.equal((await ExecutorGroup.findById(bot._id)).balance,1000);
    }
});
test('acceptance stays held until verified success and concurrent finalizers post one debit', async () => {
    const { bot, tx } = await createOrder('SUCCESS');
    let fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.apiResultData.kenanReference, '0000001');
    assert.equal(providerMoneyHold(fresh), true);
    assert.equal(automaticPaymentBlocked(fresh), true);
    assert.equal((await api.executeTransferViaApi(fresh, bot)).success, 'unresolved');
    assert.equal(postCount, 1);
    await makeDue(tx); await pollPendingOrders(); await completeDueApiTransactions();
    assert.equal((await Transaction.findById(tx._id)).status, 'processing');
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId }), 0);
    providerStatus = 'success'; await makeDue(tx); await pollPendingOrders();
    fresh = await Transaction.findById(tx._id);
    assert.equal(providerMoneyHold(fresh), true);
    await Promise.all([completeDueApiTransactions(), completeDueApiTransactions()]);
    fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.status, 'completed');
    assert.equal(fresh.executorSenderPhone, '01100000000');
    assert.equal((await ExecutorGroup.findById(bot._id)).balance, 950);
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId, type: 'TRANSFER', amount: -50 }), 1);
    assert.equal(published.mock.callCount(), 1);
    assert.equal(postCount, 1);
});
test('verified failure returns to administration without a debit or refund', async () => {
    const { bot, tx } = await createOrder('FAILED');
    providerStatus = 'failed'; await makeDue(tx); await pollPendingOrders(); await completeDueApiTransactions();
    const fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.status, 'pending');
    assert.equal(fresh.executorGroupId, undefined);
    assert.equal(providerMoneyHold(fresh), false);
    assert.equal(automaticPaymentBlocked(fresh), false);
    assert.equal((await ExecutorGroup.findById(bot._id)).balance, 1000);
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId }), 0);
    assert.equal(postCount, 1);
});

test('a throttled GET preserves acceptance and later completes through the independent Kenan worker without a second POST', async () => {
    const previous = process.env.FINANCIAL_SCHEDULERS_ENABLED;
    process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
    try {
        const { bot, tx } = await createOrder('THROTTLED-GET', {accountNumber:'01000000000'});
        const accepted = await Transaction.findById(tx._id);
        providerStatus = 'throttled';
        await makeDue(tx);
        const started = Date.now();
        const { runKenanFollowupCycle } = require('../services/kenanFollowupService');
        await runKenanFollowupCycle();
        const pending = await Transaction.findById(tx._id);
        assert.equal(pending.apiResultData.kenanLastPollOutcome,'unavailable');
        assert.equal(pending.apiResultData.kenanLastPollHttpStatus,429);
        assert.ok(new Date(pending.apiResultData.kenanNextPollAt).getTime() >= started + 180000);
        assert.equal(pending.apiResultData.kenanReceivedAt.getTime(),accepted.apiResultData.kenanReceivedAt.getTime());
        assert.equal(pending.apiResultData.kenanProviderStatus,'queued');
        assert.equal(await Ledger.countDocuments({transactionId:tx.customId}),0);
        providerStatus = 'success';
        await makeDue(tx);
        await runKenanFollowupCycle();
        const finished = await Transaction.findById(tx._id);
        assert.equal(finished.status,'completed');
        assert.equal(finished.apiResultData.kenanLastPollOutcome,'matched');
        assert.equal(finished.apiResultData.kenanLastPollHttpStatus,200);
        assert.equal((await ExecutorGroup.findById(bot._id)).balance,950);
        assert.equal(postCount,1);
        assert.equal(process.env.FINANCIAL_SCHEDULERS_ENABLED,'false');
    } finally { process.env.FINANCIAL_SCHEDULERS_ENABLED = previous; }
});
test('a new claim clears the previous rejection before any retry can be transmitted', async () => {
    const { bot, tx } = await createOrder('RETRY');
    providerStatus = 'failed'; await makeDue(tx); await pollPendingOrders();
    await Transaction.updateOne({ _id: tx._id }, { $set: { status: 'processing', executorGroupId: bot._id } });
    const retry = await Transaction.findById(tx._id);
    const claim = await claimProviderDispatch(retry);
    assert.equal(claim.claimed, true);
    const fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.apiResultData.providerDispatchResult, undefined);
    assert.equal(providerMoneyHold(fresh), true);
    assert.equal(postCount, 1);
});
test('a saved Kenan reference recovers interrupted awaiting flags and processes a verified failure', async () => {
    const { tx, bot } = await createOrder('INTERRUPTED-FLAGS');
    await makeDue(tx);
    await Transaction.updateOne({ _id: tx._id }, { $set: { 'apiResultData.kenanAwaitingStatus': false },
        $unset: { 'apiResultData.providerDispatchResult': '' } });
    providerStatus = 'failed';
    await pollPendingOrders();
    const fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.status, 'pending');
    assert.equal(fresh.apiResultData.kenanProviderStatus, 'failed');
    assert.equal(fresh.apiResultData.providerResultUnresolved, false);
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId }), 0);
    assert.equal((await ExecutorGroup.findById(bot._id)).balance, 1000);
    assert.equal(postCount, 1);
});

test('polling cannot race an administrative resolution already claimed on the order', async () => {
    const { tx } = await createOrder('MANUAL');
    await makeDue(tx);
    await Transaction.updateOne({ _id: tx._id }, { $set: { 'apiResultData.providerResolutionOutcome': 'provider_paid' } });
    providerStatus = 'success';
    await pollPendingOrders(); await completeDueApiTransactions();
    const fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.apiResultData.kenanProviderStatus, 'queued');
    assert.equal(fresh.status, 'processing');
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId }), 0);
});

test('explicit verified reconciliation while schedulers are paused commits once without another POST', async () => {
    const { bot, tx } = await createOrder('RECONCILE');
    providerStatus = 'success';
    process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
    const { reconcileKenanOrder } = require('../services/kenanReconciliationService');
    const input = { transactionId: String(tx._id), executorGroupId: String(bot._id), actor: { id: 'admin-fixture', role: 'master' } };
    const preview = await reconcileKenanOrder(input);
    assert.equal(preview.eligible, true);
    assert.equal((await Transaction.findById(tx._id)).status, 'processing');
    const results = await Promise.allSettled([reconcileKenanOrder({ ...input, confirm: true, expectedUpdatedAt: preview.expectedUpdatedAt }), reconcileKenanOrder({ ...input, confirm: true, expectedUpdatedAt: preview.expectedUpdatedAt })]);
    assert.ok(results.some(result => result.status === 'fulfilled' && result.value.applied));
    assert.equal((await Transaction.findById(tx._id)).status, 'completed');
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId, type: 'TRANSFER', amount: -50 }), 1);
    assert.equal((await ExecutorGroup.findById(bot._id)).balance, 950);
    assert.equal(postCount, 1);
    assert.equal(process.env.FINANCIAL_SCHEDULERS_ENABLED, 'false');
    process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
});

test('existing Kenan operations keep polling and complete while intake is manually closed', async () => {
    const { runKenanFollowupCycle } = require('../services/kenanFollowupService');
    process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
    try {
        const { bot, tx } = await createOrder('AUTOMATIC');
        await Settings.create({ isManualClosed: true });
        for (const status of ['queued', 'assigned', 'executing', 'verifying', 'review']) {
            providerStatus = status;
            await makeDue(tx); await runKenanFollowupCycle();
            assert.equal((await Transaction.findById(tx._id)).status, 'processing');
        }
        providerStatus = 'success'; await makeDue(tx);
        await Promise.all([runKenanFollowupCycle(), runKenanFollowupCycle()]);
        await runKenanFollowupCycle();
        const fresh = await Transaction.findById(tx._id);
        assert.equal(fresh.status, 'completed');
        assert.equal(fresh.executorSenderPhone, '01100000000');
        assert.equal(fresh.apiResultData.kenanOrder.reference, '0000001');
        assert.equal(fresh.apiResultData.kenanOrder.executor_phone, '01100000000');
        assert.equal((await ExecutorGroup.findById(bot._id)).balance, 950);
        assert.equal(await Ledger.countDocuments({ transactionId: tx.customId, type: 'TRANSFER' }), 1);
        assert.equal(postCount, 1);
        assert.equal(process.env.FINANCIAL_SCHEDULERS_ENABLED, 'false');
    } finally {
        await Settings.deleteMany({});
        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
    }
});

test('a manually completed Kenan order gets its verified receipt without another financial debit', async () => {
    const { runKenanFollowupCycle } = require('../services/kenanFollowupService');
    const { bot, tx } = await createOrder('MANUAL-RECEIPT');
    await Transaction.updateOne({ _id: tx._id }, { $set: { status: 'completed' } });
    await ExecutorGroup.updateOne({ _id: bot._id }, { $set: { balance: -50 } });
    await runKenanFollowupCycle();
    assert.equal((await Transaction.findById(tx._id)).apiResultData.executorReceiptProof, undefined);
    providerStatus = 'success';
    await Transaction.updateOne({ _id: tx._id }, { $unset: { 'apiResultData.kenanNextReceiptAt': '' } });
    await runKenanFollowupCycle();
    const fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.apiResultData.executorReceiptProof, 'proofs/kenan-fixture.jpg');
    assert.equal(fresh.executorSenderPhone, '01100000000');
    assert.equal(fresh.apiResultData.kenanOrder.status, 'success');
    assert.equal(fresh.apiResultData.kenanAwaitingStatus, false);
    assert.equal(fresh.apiResultData.providerResultUnresolved, false);
    assert.equal((await ExecutorGroup.findById(bot._id)).balance, -50);
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId }), 0);
    assert.equal(postCount, 1);
});

test('automatic Kenan follow-up holds provider success until prepaid funding is available', async () => {
    const { runKenanFollowupCycle } = require('../services/kenanFollowupService');
    const { bot, tx } = await createOrder('PREPAID-WAIT');
    await ExecutorGroup.updateOne({ _id: bot._id }, { $set: { balance: 0, apiSettlementMode: 'prepaid' } });
    providerStatus = 'success'; await makeDue(tx); await runKenanFollowupCycle();
    let fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.status, 'processing');
    assert.equal(fresh.apiResultData.kenanProviderStatus, 'success');
    assert.equal(fresh.apiResultData.kenanCompletionState, 'awaiting_funding');
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId }), 0);
    assert.equal((await ExecutorGroup.findById(bot._id)).balance, 0);
    await ExecutorGroup.updateOne({ _id: bot._id }, { $set: { balance: 100 } });
    await Transaction.updateOne({ _id: tx._id }, { $unset: { 'apiResultData.kenanNextCompletionAt': '' } });
    await runKenanFollowupCycle();
    fresh = await Transaction.findById(tx._id);
    assert.equal(fresh.status, 'completed');
    assert.equal((await ExecutorGroup.findById(bot._id)).balance, 50);
    assert.equal(await Ledger.countDocuments({ transactionId: tx.customId, type: 'TRANSFER' }), 1);
    assert.equal(postCount, 1);
});
