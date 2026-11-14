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
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Ledger = require('../models/Ledger');
const api = require('../services/externalApiService');
const { pollPendingOrders } = require('../services/kenanProviderService');
const { completeDueApiTransactions } = require('../services/apiExecutionLifecycleService');
const { providerMoneyHold, automaticPaymentBlocked, claimProviderDispatch } = require('../services/providerDispatchClaimService');
let replSet, server, url, providerStatus, postCount;
before(async () => {
    process.env.APP_ENV = 'staging';
    process.env.EXTERNAL_API_ENABLED = 'true';
    process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
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
                postCount += 1;
                res.end(JSON.stringify({ reference: '0000001', ...JSON.parse(body), status: 'queued' }));
            });
        } else if (req.url === '/api/company/orders/0000001') {
            res.end(JSON.stringify({ reference: '0000001', phone: '01000000000', amount_minor: 5000, fee_minor: 0, status: providerStatus }));
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
const createOrder = async suffix => {
    const bot = await ExecutorGroup.create({ name: 'Kenan fixture', apiProviderKey: 'kenan', apiUrl: url, apiToken: 'fixture-key', isApiBot: true, balance: 1000 });
    const tx = await Transaction.create({ customId: 'KENAN-' + suffix, status: 'processing', executorGroupId: bot._id, transferType: 'vodafone', vodafoneNumber: '01000000000', amount: 50, costLYD: 10 });
    const result = await api.executeTransferViaApi(tx, bot);
    assert.equal(result.success, 'pending');
    return { bot, tx };
};
const makeDue = tx => Transaction.updateOne({ _id: tx._id }, { $set: { 'apiResultData.kenanNextPollAt': new Date(0) } });
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
    assert.equal(fresh.executorSenderPhone, '0000001');
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
