'use strict';
// Disposable, loopback-only integration sandbox. No source database writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),https=require('node:https');
const mongoose=require('mongoose'),express=require('express');
const {MongoMemoryReplSet}=require('mongodb-memory-server');
const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const root=path.resolve(__dirname,'..');
const main=async()=>{
    const sourceUri=option('--source-uri'),configPath=option('--config');
    const port=Number(option('--port')||4582);
    if(!args.includes('--source-uri')||!args.includes('--config')||!/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/ahram_company_mobile_demo_[a-z\d_]+$/i.test(sourceUri||''))throw Error('EXPLICIT_LOCAL_DEMO_SOURCE_REQUIRED');
    if(['NODE_ENV','APP_ENV','ENVIRONMENT'].some(key=>process.env[key]==='production'))throw Error('PRODUCTION_REFUSED');
    if(!Number.isInteger(port)||port<4000||port>65000)throw Error('INVALID_LOCAL_PORT');
    const config=JSON.parse(fs.readFileSync(path.resolve(configPath),'utf8'));
    if(!config.secrets?.SESSION_SECRET)throw Error('LOCAL_DEMO_CONFIGURATION_REQUIRED');
    const repl=await MongoMemoryReplSet.create({replSet:{count:1,storageEngine:'wiredTiger'}});
    const uri=repl.getUri('merchant_integration_sandbox_'+crypto.randomBytes(6).toString('hex'));
    const sourceClient=new mongoose.mongo.MongoClient(sourceUri),targetClient=new mongoose.mongo.MongoClient(uri);
    await Promise.all([sourceClient.connect(),targetClient.connect()]);
    let copied=0;
    try {
        const sourceDb=sourceClient.db(),targetDb=targetClient.db();
        for(const item of await sourceDb.listCollections({},{nameOnly:true}).toArray()) {
            // Do not replay copied queues, notifications or old outbound deliveries.
            if(/outbox|webhookdeliver|notification|reportemaildeliver|telegramdeliver|^system\./i.test(item.name))continue;
            const rows=await sourceDb.collection(item.name).find({}).toArray();
            if(rows.length)await targetDb.collection(item.name).insertMany(rows);copied+=rows.length;
        }
    } finally {await Promise.all([sourceClient.close(),targetClient.close()]);}
    Object.assign(process.env,config.secrets,{NODE_ENV:'development',APP_ENV:'development',ENVIRONMENT:'development',
        MONGO_URI:uri,PORT:String(port),HTTP_BIND_HOST:'127.0.0.1',ALLOWED_ORIGINS:`http://127.0.0.1:${port},http://localhost:${port}`,
        DOTENV_CONFIG_PATH:path.join(root,'outputs/nonexistent-sandbox-env'),SECURE_COOKIE:'false',PASSWORD_ONLY_LOGIN_MODE:'true',CLIENT_OTP_ENABLED:'false',
        REDIS_ENABLED:'false',BULLMQ_WORKERS_ENABLED:'false',EXTERNAL_API_ENABLED:'false',FINANCIAL_SCHEDULERS_ENABLED:'false',
        MERCHANT_WEBHOOK_WORKER_ENABLED:'true',TELEGRAM_BOT_TOKEN:'',TELEGRAM_WEBHOOK_SECRET:'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',SMTP_FROM:'',
        PUPPETEER_EXECUTABLE_PATH:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const nativeConnect=require('node:net').Socket.prototype.connect;
    require('node:net').Socket.prototype.connect=function(...callArgs){
        const first=Array.isArray(callArgs[0])?callArgs[0][0]:callArgs[0];
        const host=typeof first==='object'?first.host||first.hostname:typeof callArgs[1]==='string'?callArgs[1]:null;
        if(host&&!['127.0.0.1','localhost','::1'].includes(host))throw Error('SANDBOX_EXTERNAL_SOCKET_BLOCKED');
        return nativeConnect.apply(this,callArgs);
    };
    mongoose.set('autoIndex',false);await mongoose.connect(uri);
    const Transaction=require('../models/Transaction'),Company=require('../models/ClientCompany'),User=require('../models/User');
    const Endpoint=require('../models/MerchantWebhookEndpoint'),Delivery=require('../models/MerchantWebhookDelivery');
    await Promise.all([
        Transaction.collection.createIndex({customId:1},{unique:true,name:'customId_1'}),
        Transaction.collection.createIndex({idempotencyKey:1},{unique:true,sparse:true,name:'idempotencyKey_1'}),
        require('../models/Ledger').createIndexes(),Endpoint.createIndexes(),Delivery.createIndexes(),
        require('../services/merchantWebhookOutboxService').ensureIndexes(),
    ]);
    const company=await Company.findOne({accountCode:'CO-MOBILE-DEMO'});
    const agent=await User.findOne({role:'agent',status:'active'});
    if(!company)throw Error('SOURCE_DEMO_COMPANY_MISSING');
    const receiverApp=express(),owners=[company,agent].filter(Boolean),endpointIds=[];
    for(let index=0;index<owners.length;index++) {
        const secret=crypto.randomBytes(32).toString('hex');
        const receiver=require('../examples/merchant-webhook-receiver').createReceiver({connection:mongoose.connection,secret,receiverId:'sandbox-'+index});
        await receiver.ensureIndexes();receiverApp.use('/'+index,receiver.router);
        const owner=owners[index];await owner.constructor.updateOne({_id:owner._id},{$set:{'integrationAccess.apiEnabled':true,'integrationAccess.webhooksEnabled':true}});
        const endpoint=await Endpoint.create({ownerModel:index?'User':'ClientCompany',ownerId:owner._id,tenantId:owner.tenantId,
            name:'مستقبل تجريبي معزول',url:`https://merchant-sandbox.test/${index}/webhook`,enabled:true,
            events:['transfer.created','transfer.completed','transfer.cancelled'],secretEncrypted:require('../utils/encryption').encrypt(secret)});
        endpointIds.push(endpoint._id);
    }
    const cert=fs.readFileSync(path.join(root,'tests/fixtures/merchant-receiver/test-only-cert.pem'));
    const socketPath=process.platform==='win32'?'\\\\.\\pipe\\merchant-sandbox-'+crypto.randomUUID():path.join(require('node:os').tmpdir(),'merchant-sandbox-'+crypto.randomUUID()+'.sock');
    const receiverServer=https.createServer({cert,key:fs.readFileSync(path.join(root,'tests/fixtures/merchant-receiver/test-only-key.pem'))},receiverApp);
    await new Promise(resolve=>receiverServer.listen(socketPath,resolve));
    // Only this test process adapts its synthetic destination to private TLS IPC.
    // Public application HTTPS/private-address validation is unchanged.
    require('node:dns').promises.lookup=async hostname=>{if(hostname!=='merchant-sandbox.test')throw Error('SANDBOX_EXTERNAL_NETWORK_BLOCKED');return[{address:'203.0.113.10',family:4}];};
    require('axios').post=async(url,raw,options)=>{
        const target=new URL(url);if(target.hostname!=='merchant-sandbox.test')throw Error('SANDBOX_EXTERNAL_NETWORK_BLOCKED');
        return new Promise((resolve,reject)=>{
            const req=https.request({socketPath,hostname:'localhost',servername:'localhost',ca:cert,path:target.pathname,method:'POST',headers:options.headers},res=>{
                let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,data:body}));
            });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('SANDBOX_RECEIVER_TIMEOUT')));req.end(raw);
        });
    };
    for(const endpointId of endpointIds) {
        const endpoint=await Endpoint.findById(endpointId);
        const delivery=await Delivery.create({endpointId,ownerModel:endpoint.ownerModel,ownerId:endpoint.ownerId,tenantId:endpoint.tenantId,
            eventId:'test:'+crypto.randomUUID(),eventType:'transfer.created',payload:{type:'transfer.created',test:true,data:{message:'Sandbox connection check'}}});
        const result=await require('../services/merchantWebhookService').deliverWebhook(delivery._id);
        if(!result?.delivered)throw Error('SANDBOX_RECEIVER_CHECK_FAILED');
    }
    await mongoose.disconnect();
    console.log(JSON.stringify({sandbox:true,sourceUnchanged:true,copiedDocuments:copied,endpoints:endpointIds.length,receiverTlsVerified:true,replicaSet:true,preview:`http://127.0.0.1:${port}/client/settings#integrations`}));
    process.chdir(root);require('../app');
};
main().catch(error=>{console.error(error.code||error.message);process.exit(1);});
