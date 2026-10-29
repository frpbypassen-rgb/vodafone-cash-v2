'use strict';
const {MongoMemoryServer}=require('mongodb-memory-server');
const {MongoClient,ObjectId}=require('mongodb');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let mongo,client,preload,id;
jest.setTimeout(60000);
beforeAll(async()=>{
    mongo=await MongoMemoryServer.create({binary:{version:'7.0.24'}});
    client=new MongoClient(mongo.getUri('held_restart_cli'));await client.connect();
    id=new ObjectId();
    await client.db().collection('transactions').insertMany([
        {_id:id,status:'completed',updatedAt:new Date('2026-10-29T12:00:00Z')},
        {status:'processing',updatedAt:new Date()}
    ]);
    // Isolate queue inspection; the CLI still reads a real disposable MongoDB.
    const report={mongo:{connected:true},transactions:{sampled:0,truncated:false,statuses:{}},queues:Object.fromEntries(
        ['api-transfers-queue','notifications-queue','reports-queue','backups-queue','reconciliations-queue'].map(q=>[q,{active:0,wait:0,delayed:0,prioritized:0,'waiting-children':0}]))};
    preload=path.join(os.tmpdir(),'held-cli-preload-'+String(id)+'.cjs');
    fs.writeFileSync(preload,"require('node:child_process').spawnSync=()=>({status:0,stdout:"+JSON.stringify(JSON.stringify(report))+"});");
});
afterAll(async()=>{await client?.close();await mongo?.stop();if(preload)fs.unlinkSync(preload);});
const run=(...args)=>spawnSync(process.execPath,['--require',preload,path.join(__dirname,'../scripts/checkHeldRuntimeRestart.cjs'),String(id),...args],{
    cwd:path.join(__dirname,'..'),encoding:'utf8',timeout:15000,windowsHide:true,
    env:{...process.env,MONGO_URI:mongo.getUri('held_restart_cli')}
});
test('live admission snapshot permits other work, but actual restart barriers still reject it',async()=>{
    const before=await client.db().collection('transactions').find({}).toArray();
    const snapshot=run('--allow-settled','--snapshot-only');
    expect(snapshot.status).toBe(0);
    const result=JSON.parse(snapshot.stdout);
    expect(result).toMatchObject({ok:true,snapshotOnly:true,protectedStatus:'completed'});
    expect(snapshot.stdout).not.toContain(String(id));
    const barrier=run(result.heldHash,'--allow-settled');
    expect(barrier.status).toBe(2);expect(barrier.stderr).toContain('OTHER_OPEN_TRANSACTION');
    const bypass=run(result.heldHash,'--allow-settled','--snapshot-only');
    expect(bypass.status).toBe(1);expect(bypass.stderr).toContain('INVALID_ARGUMENT');
    expect(await client.db().collection('transactions').find({}).toArray()).toEqual(before);
});
