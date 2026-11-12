'use strict';
// Only prepares indexes for the new, non-financial internal chat collections.
const fs = require('fs');
const path = require('path');

async function main() {
    const args = process.argv.slice(2);
    const position = args.indexOf('--project');
    const root = path.resolve(position >= 0 ? args[position + 1] : path.join(__dirname, '..'));
    const load = name => require(require.resolve(name, { paths: [root] }));
    const { MongoClient } = load('mongodb');
    const envPath = path.resolve(root, process.env.DOTENV_CONFIG_PATH || '.env');
    const env = fs.existsSync(envPath) ? load('dotenv').parse(fs.readFileSync(envPath)) : {};
    const uri = process.env.MONGO_URI || env.MONGO_URI;
    if(!/^mongodb(?:\+srv)?:\/\//.test(uri || '')) throw new Error('MONGO_URI_NOT_CONFIGURED');
    const apply = process.argv.includes('--apply');
    const client = new MongoClient(uri,{maxPoolSize:1,serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,socketTimeoutMS:10000,retryWrites:false});
    try {
        await client.connect();
        const db=client.db();
        const definitions=[
            {collection:'executorteammessages',key:{groupId:1,_id:-1},name:'groupId_1__id_-1'},
            {collection:'executorteamreadstates',key:{groupId:1,employeeId:1},name:'groupId_1_employeeId_1',unique:true}
        ];
        const results=[];
        for(const item of definitions){
            const exists=await db.listCollections({name:item.collection},{nameOnly:true}).hasNext();
            let indexes=exists?await db.collection(item.collection).listIndexes().toArray():[];
            let ready=indexes.some(index=>JSON.stringify(index.key)===JSON.stringify(item.key) && (!item.unique || index.unique===true));
            if(apply && !ready){
                if(!exists)await db.createCollection(item.collection);
                await db.collection(item.collection).createIndex(item.key,{name:item.name,...(item.unique?{unique:true}:{}),maxTimeMS:30000});
                ready=true;
            }
            results.push({collection:item.collection,ready});
        }
        console.log(JSON.stringify({ready:results.every(r=>r.ready),applied:apply,indexes:results,financialDataChanged:false,processesChanged:false},null,2));
        if(!results.every(r=>r.ready))process.exitCode=2;
    } finally {await client.close();}
}
main().catch(error=>{console.error(JSON.stringify({ready:false,code:String(error.code || 'INDEX_PREPARATION_FAILED'),message:'Team chat index preparation stopped; no financial records or processes were changed.'}));process.exitCode=1;});
