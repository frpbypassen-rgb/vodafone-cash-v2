'use strict';
const mongoose=require('mongoose'),express=require('express'),request=require('supertest'),crypto=require('node:crypto');
const {MongoMemoryReplSet}=require('mongodb-memory-server');
let repl,receiver,app;
const secret='receiver-test-secret-not-used-outside-tests';
const payload=(type='transfer.completed',status='completed')=>({id:crypto.randomUUID(),type,created_at:new Date().toISOString(),data:{transaction_id:'123456789012345678901234',reference:'TEST',status}});
const send=(body,options={})=>{const raw=JSON.stringify(body),timestamp=String(options.timestamp||Math.floor(Date.now()/1000));return request(app).post('/webhook').set('content-type','application/json').set('x-ahrampay-timestamp',timestamp).set('x-ahrampay-signature',options.signature||'sha256='+crypto.createHmac('sha256',secret).update(timestamp+'.'+raw).digest('hex')).send(raw);};
beforeAll(async()=>{repl=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(repl.getUri());receiver=require('../examples/merchant-webhook-receiver').createReceiver({connection:mongoose.connection,secret,receiverId:'test'});await receiver.ensureIndexes();app=express();app.use(receiver.router);});
afterAll(async()=>{await mongoose.disconnect();await repl.stop();});
afterEach(async()=>{await receiver.Inbox.deleteMany({});await receiver.State.deleteMany({});});
test('rejects tampering and stale signatures before any persistence',async()=>{
 expect((await send(payload(),{signature:'sha256='+'0'.repeat(64)})).status).toBe(401);
 expect((await send(payload(),{timestamp:Math.floor(Date.now()/1000)-600})).status).toBe(401);
 expect(await receiver.Inbox.countDocuments({})).toBe(0);
});
test('concurrent replays persist one receipt and late creation cannot regress a completed transfer',async()=>{
 const terminal=payload();const results=await Promise.all(Array.from({length:8},()=>send(terminal)));
 expect(results.every(r=>r.status===200)).toBe(true);expect(await receiver.Inbox.countDocuments({})).toBe(1);
 expect((await send(payload('transfer.created','pending'))).status).toBe(200);
 expect((await receiver.State.findOne()).status).toBe('completed');expect((await receiver.State.findOne()).appliedCount).toBe(1);
 expect((await send(payload('transfer.cancelled','rejected'))).status).toBe(409);
 expect((await receiver.State.findOne()).status).toBe('completed');
});
test('a signed reused event ID with different content is a conflict, not another application',async()=>{
 const body=payload();expect((await send(body)).status).toBe(200);
 expect((await send({...body,data:{...body.data,reference:'CHANGED'}})).status).toBe(409);
 expect(await receiver.Inbox.countDocuments({})).toBe(1);
});
test('signed connection probes acknowledge without creating a mirrored financial operation',async()=>{
 const body={type:'transfer.created',test:true,data:{message:'AhramPay webhook connection test'}};
 expect((await send(body)).body).toEqual({received:true,test:true});
 expect(await receiver.State.countDocuments({})).toBe(0);expect(await receiver.Inbox.countDocuments({})).toBe(0);
});
