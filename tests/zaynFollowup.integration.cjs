'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Campaign = require('../models/RateAlertCampaign');
const Ledger = require('../models/Ledger');
const queue = require('../services/queueService');
const monitor = require('../services/apiPendingMonitorService');

for (const [reply, expected] of [
    [{TransactionStatus:'عملية ناجحة'}, 'paid'],
    [{TransactionStatus:'تم إلغاء العملية وردها'}, 'returned'],
    [{Status:'تم إلغاء العملية'}, 'returned']
]) test('new Zayn dispatch reaches ' + JSON.stringify(reply) + ' without paying twice or running price campaigns', async () => {
    Object.assign(process.env, {APP_ENV:'staging', RUNTIME_ROLE:'full', EXTERNAL_API_ENABLED:'true',
        ZAYN_AUTO_FOLLOWUP_ENABLED:'true', API_PENDING_MONITOR_ENABLED:'false', FINANCIAL_SCHEDULERS_ENABLED:'false'});
    const phone = '01000000000';
    const number = reply.Status ? '810074' : 'wire-zayn-301';
    const expectedWireNumber = reply.Status ? 810074 : number;
    const calls = [];
    let receipt = {TransactionStatus:'pending'};
    let unavailable = false;
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        calls.push({path:req.url, number:body.TransactionNumber || null});
        res.setHeader('Content-Type', 'application/json');
        if (req.headers.authorization !== 'Bearer fixture-token') return res.writeHead(401).end();
        if (req.url.endsWith('/Print') && body.TransactionNumber !== expectedWireNumber) {
            return res.end(JSON.stringify({Code:500, Data:null}));
        }
        if (unavailable && req.url.endsWith('/Print')) {
            res.setHeader('Retry-After', '600');
            return res.writeHead(503).end(JSON.stringify({Code:4021, Message:'sensitive diagnostic text',
                Data:{TransactionId:number, TransactionStatus:'cancelled', PhoneNumber:phone, Amount:100}}));
        }
        let data;
        switch (req.url) {
        case '/api/Account/GetBalance': data = {AvailableBalance:2000}; break;
        case '/api/V1/Transactions/Inquiry': data = {PaymentBillInfo:'fixture-bill'}; break;
        case '/api/V1/Transactions/Payment': data = {TransactionNumber:number, RefNumber:phone, Status:'pending'}; break;
        case '/api/V1/Transactions/Print': data = {TransactionId:number, PhoneNumber:phone, Amount:100, RefNumber:phone,
            ...receipt}; break;
        default: return res.writeHead(404).end();
        }
        res.end(JSON.stringify({Code:200, Data:data}));
    });
    let repl;
    try {
        await new Promise((resolve, reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
        repl = await MongoMemoryReplSet.create({replSet:{count:1, storageEngine:'wiredTiger'}});
        await mongoose.connect(repl.getUri(), {dbName:'zayn_order_followup', autoIndex:false});
        const group = await ExecutorGroup.create({name:'Wire test Zayn', isApiBot:true, balance:2000,
            apiUrl:'http://127.0.0.1:'+server.address().port, apiProviderKey:'zayn_external_aggregator', apiToken:'fixture-token'});
        const txData = {status:'processing', transferType:'vodafone', amount:100, costLYD:20,
            executorGroupId:group._id, vodafoneNumber:phone};
        const tx = await Transaction.create({...txData, customId:'WIRE-NEW'});
        const older = await Transaction.create({...txData, customId:'WIRE-OLDER',
            apiResultData:{providerTransactionId:'historic-number', providerResultUnresolved:true}, createdAt:new Date(Date.now()-86400000)});
        const campaign = await Campaign.create({reference:'ZAYN-LAB', effectiveAt:new Date(Date.now()-60000),
            changes:{cashRateLevel1:8}, previousRates:{cashRateLevel1:7}});
        const oldSnapshot = await Transaction.collection.findOne({_id:older._id});
        const campaignSnapshot = await Campaign.collection.findOne({_id:campaign._id});
        await queue.processSingleJob(tx._id, group._id);
        const pending = await Transaction.findById(tx._id).lean();
        assert.ok(pending.apiResultData.providerDispatchAttemptId);
        assert.equal(pending.apiResultData.zaynFollowupAttemptId,pending.apiResultData.providerDispatchAttemptId);
        assert.equal(pending.apiResultData.providerTransactionId,number);
        await queue.processSingleJob(tx._id, group._id);
        assert.deepEqual(await monitor.runPendingMonitorCycle(),{checked:1});
        assert.equal((await Transaction.findById(tx._id)).apiResultData.providerMatchedState,'pending');
        // Advance only this disposable row's due time, preserving the business state and the actual HTTP call.
        await Transaction.updateOne({_id:tx._id},{$set:{'apiResultData.providerMonitorNextCheckAt':new Date(0)}});
        if (reply.Status) {
            unavailable = true;
            assert.deepEqual(await monitor.runPendingMonitorCycle(), {checked:1});
            const failed = (await Transaction.findById(tx._id).lean()).apiResultData;
            assert.equal(failed.providerLastCheckStage,'print');
            assert.equal(failed.providerLastCheckHttpStatus,503);
            assert.equal(failed.providerLastCheckProviderCode,4021);
            assert.equal(failed.providerLastCheckRetryAfterSeconds,600);
            assert.equal(failed.providerLastCheckRetrySource,'provider_header');
            assert.equal(failed.providerMonitorState,'failed');
            assert.equal(failed.providerMonitorStopped,false);
            assert.equal(failed.providerMatchedState,'pending');
            assert.ok(!JSON.stringify(failed).includes('sensitive diagnostic text'));
            await Transaction.updateOne({_id:tx._id},{$set:{'apiResultData.providerMonitorNextCheckAt':new Date(0)}});
            unavailable = false;
        }
        receipt = reply;
        assert.deepEqual(await monitor.runPendingMonitorCycle(),{checked:1});
        assert.deepEqual(await monitor.runPendingMonitorCycle(),{checked:0});
        const done = await Transaction.findById(tx._id).lean();
        assert.equal(done.apiResultData.providerMatchedState,expected);
        assert.equal(done.apiResultData.providerMonitorStopped,true);
        assert.equal(done.status,'processing');
        assert.equal(done.apiResultData.providerLastCheckHttpStatus,200);
        assert.equal(done.apiResultData.providerLastCheckProviderCode,200);
        assert.equal(done.apiResultData.providerLastCheckRetryAfterSeconds,null);
        assert.equal((await ExecutorGroup.findById(group._id)).balance,2000);
        assert.equal(await Ledger.countDocuments({transactionId:tx.customId}),0);
        assert.deepEqual(await Transaction.collection.findOne({_id:older._id}),oldSnapshot);
        assert.deepEqual(await Campaign.collection.findOne({_id:campaign._id}),campaignSnapshot);
        assert.equal(calls.filter(c=>c.path.endsWith('/Payment')).length,1);
        assert.deepEqual(calls.filter(c=>c.path.endsWith('/Print')).map(c=>c.number),Array(reply.Status ? 3 : 2).fill(expectedWireNumber));
    } finally {
        if (server.listening) await new Promise(resolve=>server.close(resolve));
        await mongoose.disconnect();
        if (repl) await repl.stop();
    }
});
