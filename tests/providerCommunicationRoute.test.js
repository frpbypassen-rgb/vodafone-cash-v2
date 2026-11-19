'use strict';

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const axios = require('axios');
const { MongoMemoryServer } = require('mongodb-memory-server');
const transactions = require('../routes/adminTransactions');
const Transaction = require('../models/Transaction');
const Group = require('../models/ExecutorGroup');

const id = () => new mongoose.Types.ObjectId();
const own = id(), foreign = id(), group = id(), otherGroup = id(), txn = id();
const path = '/transactions/' + txn + '/provider-communication';
const initial = { _id:txn, tenantId:own, customId:'fixture', status:'processing', executorGroupId:group,
    notes:'private-fixture-note', apiResultData:{ kenanReference:'0000123', kenanProviderStatus:'queued', kenanAwaitingStatus:true,
        providerLastCheckedRaw:{private:'private-fixture-payload'} } };
let mongo;
const flags = { TENANT_MODE:'multi', KENAN_AUTO_FOLLOWUP_ENABLED:'true', EXTERNAL_API_ENABLED:'true',
    ZAYN_AUTO_FOLLOWUP_ENABLED:'true', RUNTIME_ROLE:'full' };
const originals = Object.fromEntries(Object.keys(flags).map(key => [key,process.env[key]]));
const app = express();
// Only session establishment and tenant resolution use fixtures. Real routing,
// authorization, Mongoose projections, local persistence and rendering run below.
app.use((req, res, next) => {
    req.session = { isLoggedIn:Boolean(req.get('x-test-permission')), adminRole:'admin',
        adminPermissions:[req.get('x-test-permission')] };
    req.tenantId = req.get('x-test-tenant');
    next();
});
app.use(transactions);
const read = (route, permission, tenant) => {
    const lookup = request(app).get(route).set('Accept','application/json');
    if (permission) lookup.set('x-test-permission',permission);
    if (tenant) lookup.set('x-test-tenant',String(tenant));
    return lookup;
};
beforeAll(async () => {
    Object.assign(process.env,flags);
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), {autoIndex:false, autoCreate:false});
    await Group.collection.insertMany([group,otherGroup].map(_id => ({_id,tenantId:own,isApiBot:true,status:'active'})));
}, 60000);
beforeEach(async () => {
    Object.assign(process.env,flags);
    await Transaction.collection.replaceOne({_id:txn}, initial, {upsert:true});
    for (const verb of ['get','post']) jest.spyOn(axios,verb).mockImplementation(() => { throw new Error('UNEXPECTED_PROVIDER_CALL'); });
});
afterEach(() => {
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    for (const [key,value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

test('both authorized views read the same saved receipt, preserve the row and omit unstructured private fields', async () => {
    const before = await Transaction.collection.findOne({_id:txn});
    const response = await read(path,'transactions.read',own).expect(200);
    const scoped = await read('/executor/'+group+path,'executors.read',own).expect(200);
    expect(scoped.body).toEqual(response.body);
    expect(response.body).toMatchObject({confirmed:true,refresh:true});
    expect(response.body.text).toContain('0000123');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.text).not.toContain('private-fixture');
    expect(await Transaction.collection.findOne({_id:txn})).toEqual(before);
});
test('session, permission, tenant and executor ownership all constrain local reads', async () => {
    await read(path,null,own).expect(401);
    await read(path,'executors.read',own).expect(403);
    await read(path,'transactions.read',foreign).expect(404);
    await read(path,'transactions.read',null).expect(403);
    await read('/executor/'+otherGroup+path,'executors.read',own).expect(404);
    await read('/executor/'+group+path,'transactions.read',own).expect(403);
    await read('/executor/'+group+path,'executors.read',foreign).expect(404);
});
test('no refresh when disabled, locally terminal, missing a matching provider ID or after a different attempt', async () => {
    process.env.KENAN_AUTO_FOLLOWUP_ENABLED='false';
    expect((await read(path,'transactions.read',own).expect(200)).body.refresh).toBe(false);
    process.env.KENAN_AUTO_FOLLOWUP_ENABLED='true';
    await Transaction.collection.updateOne({_id:txn},{$set:{'apiResultData.kenanProviderStatus':'success',
        'apiResultData.kenanCompletionState':'awaiting_funding'}});
    const settled = await read(path,'transactions.read',own).expect(200);
    expect(settled.body.text).toContain('بانتظار تمويل حساب المنفذ');
    expect(settled.body.refresh).toBe(false);
    const data = {providerDispatchAttemptId:'current',zaynFollowupAttemptId:'current',providerTransactionId:'000456',
        providerResultUnresolved:true,providerDispatchExecutorGroupId:group,zaynPaymentReplyState:'pending'};
    const observe = async (attrs,status='processing') => {
        await Transaction.collection.updateOne({_id:txn},{$set:{apiResultData:attrs,status}});
        return (await read(path,'transactions.read',own).expect(200)).body.refresh;
    };
    expect(await observe(data)).toBe(true);
    expect(await observe(data,'completed')).toBe(false);
    expect(await observe({...data,providerMonitorStopped:true})).toBe(false);
    expect(await observe({...data,providerTransactionId:''})).toBe(false);
    expect(await observe({...data,zaynFollowupAttemptId:'old'})).toBe(false);
    expect(await observe({...data,providerDispatchExecutorGroupId:otherGroup})).toBe(false);
});
