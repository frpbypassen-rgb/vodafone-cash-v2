'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Transaction = require('../models/Transaction');
const Company = require('../models/ClientCompany');
const Endpoint = require('../models/MerchantWebhookEndpoint');
const Delivery = require('../models/MerchantWebhookDelivery');
let repl;
beforeAll(async()=>{repl=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(repl.getUri());await Transaction.init();},60000);
afterAll(async()=>{await mongoose.disconnect();await repl?.stop();},60000);
afterEach(async()=>{await Transaction.deleteMany({});});
const seed = (extra={})=>({_id:new mongoose.Types.ObjectId(), customId:'OB-'+new mongoose.Types.ObjectId(),companyId:new mongoose.Types.ObjectId(),status:'pending',amount:1000,costLYD:200,...extra});
test('creation and terminal event snapshots commit with the document and are hidden from normal reads',async()=>{
 const tx=await Transaction.create(seed());
 let row=await Transaction.findById(tx._id).select('+merchantWebhookCreatedEvent +merchantWebhookCompletedEvent +merchantWebhookCancelledEvent').lean();
 expect(row.merchantWebhookCreatedEvent.pending).toBe(true);
 expect(row.merchantWebhookCreatedEvent.payload.data.status).toBe('pending');
 expect((await Transaction.findById(tx._id).lean()).merchantWebhookCreatedEvent).toBeUndefined();
 await Transaction.findOneAndUpdate({_id:tx._id,status:'pending'},{$set:{status:'completed',completedAt:new Date()}});
 row=await Transaction.findById(tx._id).select('+merchantWebhookCreatedEvent +merchantWebhookCompletedEvent +merchantWebhookCancelledEvent').lean();
 expect(row.merchantWebhookCompletedEvent.pending).toBe(true);
 expect(row.merchantWebhookCompletedEvent.payload.data.status).toBe('completed');
 expect(row.merchantWebhookCreatedEvent.payload.data.status).toBe('pending');
});
test('financial rollback removes creation and query-update events',async()=>{
 const session=await mongoose.startSession();const doc=seed();
 session.startTransaction();await Transaction.create([doc],{session});await session.abortTransaction();
 expect(await Transaction.findById(doc._id)).toBeNull();
 const tx=await Transaction.create(seed());session.startTransaction();
 await Transaction.updateOne({_id:tx._id},{$set:{status:'rejected',cancellationReason:'test'}},{session});await session.abortTransaction();await session.endSession();
 const row=await Transaction.findById(tx._id).select('+merchantWebhookCreatedEvent +merchantWebhookCompletedEvent +merchantWebhookCancelledEvent').lean();
 expect(row.status).toBe('pending');expect(row.merchantWebhookCancelledEvent).toBeUndefined();
});
test('non-business accounting records do not create transfer notifications',async()=>{
 const tx=await Transaction.create(seed({transferType:'balance_transfer'}));
 expect((await Transaction.findById(tx._id).select('+merchantWebhookCreatedEvent +merchantWebhookCompletedEvent +merchantWebhookCancelledEvent').lean()).merchantWebhookCreatedEvent).toBeUndefined();
});
test('restart drain stages immutable events once and leaves pending work after a failed write',async()=>{
 const worker=require('../services/merchantWebhookOutboxService');
 await worker.ensureIndexes();await Delivery.createIndexes();
 const company=await Company.create({name:'Durable owner',integrationAccess:{webhooksEnabled:true}});
 await Endpoint.create({ownerModel:'ClientCompany',ownerId:company._id,url:'https://receiver.example/webhook',secretEncrypted:'unused',events:['transfer.created','transfer.completed'],enabled:true});
 const tx=await Transaction.create(seed({companyId:company._id}));
 await Transaction.findOneAndUpdate({_id:tx._id},{$set:{status:'completed'}});
 const spy=jest.spyOn(Delivery,'bulkWrite').mockRejectedValueOnce(new Error('SIMULATED_CRASH_BEFORE_DELIVERY_STAGE'));
 await worker.drain();spy.mockRestore();
 expect((await Transaction.findById(tx._id).select('+merchantWebhookCreatedEvent')).merchantWebhookCreatedEvent.pending).toBe(true);
 await Promise.all([worker.drain(),worker.drain()]);await worker.drain();
 const deliveries=await Delivery.find({ownerId:company._id}).lean();
 expect(deliveries).toHaveLength(2);
 expect(deliveries.find(d=>d.eventType==='transfer.created').payload.data.status).toBe('pending');
 expect(deliveries.find(d=>d.eventType==='transfer.completed').payload.data.status).toBe('completed');
 const row=await Transaction.findById(tx._id).select('+merchantWebhookCreatedEvent +merchantWebhookCompletedEvent');
 expect(row.merchantWebhookCreatedEvent.pending).toBe(false);expect(row.merchantWebhookCompletedEvent.pending).toBe(false);
 const second=await Transaction.create(seed({companyId:company._id}));
 const ack=jest.spyOn(Transaction,'updateOne').mockRejectedValueOnce(new Error('SIMULATED_CRASH_AFTER_STAGE'));
 await worker.drain();ack.mockRestore();
 expect((await Transaction.findById(second._id).select('+merchantWebhookCreatedEvent')).merchantWebhookCreatedEvent.pending).toBe(true);
 await worker.drain();expect(await Delivery.countDocuments({ownerId:company._id})).toBe(3);
 await Promise.all([Company.deleteMany({}),Endpoint.deleteMany({}),Delivery.deleteMany({})]);
});
test('new subscriptions do not receive an earlier queued event',async()=>{
 const worker=require('../services/merchantWebhookOutboxService');await worker.ensureIndexes();
 const company=await Company.create({name:'Later subscriber',integrationAccess:{webhooksEnabled:true}});
 const tx=await Transaction.create(seed({companyId:company._id}));
 await Endpoint.create({ownerModel:'ClientCompany',ownerId:company._id,url:'https://receiver.example/webhook',secretEncrypted:'unused',events:['transfer.created'],enabled:true,createdAt:new Date(Date.now()+10000)});
 await worker.drain();expect(await Delivery.countDocuments({ownerId:company._id})).toBe(0);
 expect((await Transaction.findById(tx._id).select('+merchantWebhookCreatedEvent')).merchantWebhookCreatedEvent.pending).toBe(false);
 await Promise.all([Company.deleteMany({}),Endpoint.deleteMany({}),Delivery.deleteMany({})]);
});
test('queue lag diagnostics are read-only and exclude another owner and expected future retries',async()=>{
 const worker=require('../services/merchantWebhookOutboxService');await worker.ensureIndexes();
 const first=seed(),second=seed();await Transaction.create([first,second]);
 await Transaction.updateOne({_id:first._id},{$set:{'merchantWebhookCreatedEvent.stagedAt':new Date(Date.now()-180000)}});
 await Transaction.updateOne({_id:second._id},{$set:{'merchantWebhookCreatedEvent.stagedAt':new Date(Date.now()-600000)}});
 const owner={ownerModel:'ClientCompany',ownerId:first.companyId};
 await Delivery.create({...owner,endpointId:new mongoose.Types.ObjectId(),eventId:'future-retry',eventType:'transfer.created',payload:{},status:'failed',attemptCount:1,nextAttemptAt:new Date(Date.now()+3600000)});
 const before=await Transaction.findById(first._id).select('+merchantWebhookCreatedEvent').lean();
 const stats=await worker.queueStats(owner);
 expect(stats).toMatchObject({available:true,pendingEvents:1,pendingDeliveries:0,delayed:true});
 expect(stats.oldestAgeSeconds).toBeGreaterThanOrEqual(180);expect(stats.oldestAgeSeconds).toBeLessThan(200);
 expect(await Transaction.findById(first._id).select('+merchantWebhookCreatedEvent').lean()).toEqual(before);
 expect((await worker.queueStats({ownerModel:'ClientCompany',ownerId:new mongoose.Types.ObjectId()})).pendingEvents).toBe(0);
 await Delivery.deleteMany({});
});

test('agent queue ownership prefers the explicit actor and keeps strict tenant isolation',async()=>{
 const worker=require('../services/merchantWebhookOutboxService');await worker.ensureIndexes();
 const agent=new mongoose.Types.ObjectId(),otherAgent=new mongoose.Types.ObjectId(),tenant=new mongoose.Types.ObjectId(),foreignTenant=new mongoose.Types.ObjectId();
 const mode=jest.spyOn(require('../middlewares/tenantResolver'),'tenantMode').mockReturnValue('multi');
 try {
  await Transaction.create([
   seed({companyId:null,userId:'shared-legacy',clientActorModel:'User',clientActorId:String(agent),tenantId:tenant}),
   seed({companyId:null,userId:'shared-legacy',clientActorModel:'User',clientActorId:String(otherAgent),tenantId:tenant}),
   seed({companyId:null,userId:'shared-legacy',clientActorModel:'User',clientActorId:String(agent),tenantId:foreignTenant}),
   seed({companyId:null,userId:'shared-legacy',tenantId:tenant}),
  ]);
  const owner={ownerModel:'User',ownerId:agent,tenantId:tenant,identifiers:['shared-legacy']};
  expect(await worker.queueStats(owner)).toMatchObject({available:true,pendingEvents:2});
  expect(await worker.queueStats({...owner,tenantId:null})).toMatchObject({available:true,pendingEvents:0});
 } finally {mode.mockRestore();}
});
