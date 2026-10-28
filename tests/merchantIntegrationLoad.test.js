'use strict';
jest.mock('../services/autoRouteService',()=>({resolveAutoRouteExecutor:jest.fn(async()=>null),applyAutoRouteFields:jest.fn(),enqueueAutoRouteIfNeeded:jest.fn(async()=>{})}));
jest.mock('../services/eventBus',()=>({publish:jest.fn()}));
jest.mock('axios',()=>({post:jest.fn()}));
const mongoose=require('mongoose'),express=require('express'),request=require('supertest');
const https=require('node:https'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),dns=require('node:dns').promises;
const {MongoMemoryReplSet}=require('mongodb-memory-server');
const Transaction=require('../models/Transaction'),Company=require('../models/ClientCompany'),User=require('../models/User'),Ledger=require('../models/Ledger'),Counter=require('../models/Counter'),Settings=require('../models/Settings');
const Endpoint=require('../models/MerchantWebhookEndpoint'),Delivery=require('../models/MerchantWebhookDelivery');
const outbox=require('../services/merchantWebhookOutboxService'),webhooks=require('../services/merchantWebhookService');
const {createReceiver}=require('../examples/merchant-webhook-receiver');
const pool=async(items,concurrency,work)=>{let cursor=0;await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<items.length){const index=cursor++;await work(items[index],index);}}));};
let repl,server,app,owners,receivers,dnsSpy,oldWorker,oldRedis;
const COUNT=600;
jest.setTimeout(240000);
beforeAll(async()=>{
 oldWorker=process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;oldRedis=process.env.REDIS_ENABLED;
 process.env.MERCHANT_WEBHOOK_WORKER_ENABLED='true';process.env.REDIS_ENABLED='false';
 repl=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(repl.getUri());
 await Promise.all([Transaction.init(),Company.init(),User.init(),Ledger.init(),Counter.init(),Settings.init(),Delivery.createIndexes(),outbox.ensureIndexes()]);
 await Settings.create({rateLevel3:5,cashRateLevel3:5});
 owners=[await Company.create({name:'LOAD COMPANY',tier:3,balance:100000,token:'load-company-test-token',integrationAccess:{apiEnabled:true,webhooksEnabled:true}}),
 await User.create({name:'LOAD AGENT',role:'agent',webUsername:'load-agent',webPassword:'not-a-real-password',tier:3,balance:100000,apiToken:'load-agent-test-token',integrationAccess:{apiEnabled:true,webhooksEnabled:true}})];
 receivers=[];const receiverApp=express();
 for(let index=0;index<2;index++){
  const secret=crypto.randomBytes(32).toString('hex');
  const receiver=createReceiver({connection:mongoose.connection,secret,receiverId:'load-'+index});await receiver.ensureIndexes();receivers.push(receiver);receiverApp.use('/'+index,receiver.router);
  await Endpoint.create({ownerModel:index?'User':'ClientCompany',ownerId:owners[index]._id,url:`https://merchant-receiver.test/${index}/webhook`,events:['transfer.created','transfer.completed','transfer.cancelled'],enabled:true,secretEncrypted:require('../utils/encryption').encrypt(secret)});
 }
 const cert=fs.readFileSync(path.join(__dirname,'fixtures/merchant-receiver/test-only-cert.pem'));
 server=https.createServer({cert,key:fs.readFileSync(path.join(__dirname,'fixtures/merchant-receiver/test-only-key.pem'))},receiverApp);
 // TLS over private IPC keeps antivirus self-signed-site substitution out of this
 // isolated transport. Certificate chain and hostname verification stay enabled.
 const socketPath=process.platform==='win32'?'\\\\.\\pipe\\merchant-receiver-'+crypto.randomUUID()
  :path.join(require('node:os').tmpdir(),'merchant-receiver-'+crypto.randomUUID()+'.sock');
 await new Promise(resolve=>server.listen(socketPath,resolve));
 await new Promise((resolve,reject)=>{const req=https.get({socketPath,hostname:'localhost',servername:'localhost',ca:cert,path:'/tls-preflight'},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);});
 dnsSpy=jest.spyOn(dns,'lookup').mockImplementation(async hostname=>{if(hostname!=='merchant-receiver.test')throw Error('EXTERNAL_NETWORK_FORBIDDEN');return[{address:'203.0.113.10',family:4}];});
 const lostAck=new Set();let calls=0;
 require('axios').post.mockImplementation(async(url,raw,options)=>{
  const target=new URL(url);if(target.hostname!=='merchant-receiver.test')throw Error('EXTERNAL_NETWORK_FORBIDDEN');
  const result=await new Promise((resolve,reject)=>{
   const req=https.request({socketPath,hostname:'localhost',servername:'localhost',ca:cert,path:target.pathname,method:'POST',headers:options.headers},res=>{let body='';res.on('data',data=>{body+=data;});res.on('end',()=>resolve({status:res.statusCode,data:body}));});req.on('error',reject);req.end(raw);
  });
  calls++;const id=options.headers['x-ahrampay-event-id'];
  if(lostAck.size<120&&calls%10===0&&!lostAck.has(id)){lostAck.add(id);throw Error('SIMULATED_LOST_ACK_AFTER_RECEIVER_COMMIT');}
  return result;
 });
 app=express();app.use(express.json());app.use('/api/v1/merchant',require('../routes/merchantApi'));
});
afterAll(async()=>{
 dnsSpy?.mockRestore();if(server)await new Promise(resolve=>server.close(resolve));
 await mongoose.disconnect();await repl?.stop();
 if(oldWorker===undefined)delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;else process.env.MERCHANT_WEBHOOK_WORKER_ENABLED=oldWorker;
 if(oldRedis===undefined)delete process.env.REDIS_ENABLED;else process.env.REDIS_ENABLED=oldRedis;
});
test('600 synthetic transfers, 1200 replays and signed HTTPS deliveries preserve every financial and receiver invariant',async()=>{
 const start=Date.now();let requests=0,conflicts=0;
 const orders=Array.from({length:COUNT},(_,i)=>({owner:i%2,key:'load-order-'+i,body:{target_number:String(1010000000+i).padStart(11,'0'),amount:1000,transfer_type:'vodafone'}}));
 const send=order=>{requests++;return request(app).post('/api/v1/merchant/transfer').set('x-api-key',order.owner?'load-agent-test-token':'load-company-test-token').set('Idempotency-Key',order.key).send(order.body);};
 await pool(orders,6,async order=>{
  for(let attempt=0;attempt<100;attempt++){
   const result=await send(order);if(result.status===200){order.result=result.body;return;}
   expect(result.status).toBe(409);conflicts++;await new Promise(resolve=>setTimeout(resolve,20));
  }throw Error('LOAD_RETRY_BUDGET_EXHAUSTED');
 });
 await pool(orders.flatMap(order=>[order,order]),16,async order=>{const result=await send(order);expect(result.status).toBe(200);expect(result.body).toEqual(order.result);expect(result.headers['idempotency-replayed']).toBe('true');});
 expect(await Transaction.countDocuments({})).toBe(COUNT);expect(await Ledger.countDocuments({})).toBe(COUNT);
 expect((await Company.findById(owners[0]._id)).balance).toBe(40000);expect((await User.findById(owners[1]._id)).balance).toBe(40000);
 expect(await Delivery.countDocuments({})).toBe(0); // No in-memory event listener is needed for recovery.
 const txs=await Transaction.find().lean();
 await pool(txs,8,async(tx,index)=>{await Transaction.updateOne({_id:tx._id,status:'pending'},{$set:{status:index%2?'rejected':'completed',...(index%2?{cancellationReason:'SYNTHETIC TEST'}:{completedAt:new Date()})}});});
 for(let round=0;round<8;round++)await Promise.all([outbox.drain(100),outbox.drain(100)]);
 expect(await Delivery.countDocuments({})).toBe(COUNT*2);
 // Deliver terminal events first, deliberately reversing arrival order.
 const deliveries=await Delivery.find().sort({eventType:-1}).lean();
 const terminal=deliveries.filter(d=>d.eventType!=='transfer.created'),created=deliveries.filter(d=>d.eventType==='transfer.created');
 await pool(terminal,12,d=>webhooks.deliverWebhook(d._id));await pool(created,12,d=>webhooks.deliverWebhook(d._id));
 let failures=await Delivery.find({status:'failed'}).lean();const retried=failures.length;
 for(let round=0;failures.length&&round<6;round++){
  await pool(failures,12,async d=>{await webhooks.requestWebhookRetry({_id:d._id});await webhooks.deliverWebhook(d._id);});
  failures=await Delivery.find({status:'failed'}).lean();
 }
 expect(failures).toHaveLength(0);expect(await Delivery.countDocuments({status:'delivered'})).toBe(COUNT*2);
 expect(await receivers[0].Inbox.countDocuments({})).toBe(COUNT*2); // Shared models; receiverId remains part of every unique key.
 expect(await receivers[0].State.countDocuments({})).toBe(COUNT);
 expect(await receivers[0].State.countDocuments({appliedCount:{$ne:1}})).toBe(0);
 for(const tx of await Transaction.find().lean()){
  const state=await receivers[0].State.findOne({transactionId:String(tx._id)}).lean();expect(state.status).toBe(tx.status);
 }
 const report={uniqueTransfers:COUNT,successfulReplays:COUNT*2,httpRequests:requests,transientConflicts:conflicts,ledgerRows:await Ledger.countDocuments({}),webhookEvents:COUNT*2,retriedLostAcknowledgements:retried,receiverReceipts:await receivers[0].Inbox.countDocuments({}),receiverStates:await receivers[0].State.countDocuments({}),duplicateFinancialWrites:0,externalProviderCalls:0,elapsedMs:Date.now()-start};
 fs.mkdirSync(path.join(__dirname,'../outputs'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../outputs/merchant-integration-load-result.json'),JSON.stringify(report,null,2));
});
