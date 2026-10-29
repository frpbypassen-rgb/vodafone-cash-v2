'use strict';
const {createHash}=require('node:crypto');
const hash=tx=>createHash('sha256').update(JSON.stringify(tx)).digest('hex');
const assertManual=(tx,group)=>{
    const d=tx?.apiResultData||{};
    if(!tx||!['pending','accepted'].includes(tx.status)||tx.originalApiGroupId||tx.isApiReview
        ||d.providerDispatchStartedAt||d.providerDispatchAttemptId||d.providerDispatchResult
        ||d.providerResultUnresolved||d.waitingApiAutoCompletion
        ||(tx.executorGroupId?group?.isApiBot!==false:tx.status!=='pending'))
        throw new Error('UNSAFE_OPEN_TRANSACTION');
};
const parseManifest=value=>{
    if(!value)return [];
    const rows=value.split(',');
    if(rows.length>50||rows.some(row=>!/^([a-f\d]{24}):([a-f\d]{64})$/.test(row)))throw new Error('INVALID_ARGUMENT');
    const parsed=rows.map(row=>{const [id,digest]=row.split(':');return{id,digest};});
    if(new Set(parsed.map(row=>row.id)).size!==parsed.length)throw new Error('INVALID_ARGUMENT');
    return parsed;
};
const inspectManual=async(db,heldId,ObjectId,capture,manifest)=>{
    const collection=db.collection('transactions');
    const specs=parseManifest(manifest);
    const rows= capture
        ? await collection.find({status:{$in:['pending','processing','accepted','deposit_pending']},_id:{$ne:heldId}}).limit(51).maxTimeMS(2000).toArray()
        : await collection.find({_id:{$in:specs.map(row=>new ObjectId(row.id))}}).limit(51).maxTimeMS(2000).toArray();
    if(rows.length>50||(!capture&&rows.length!==specs.length))throw new Error('MANUAL_STATE_CHANGED');
    const result=[];
    for(const tx of rows){
        if(capture){
            const group=tx.executorGroupId?await db.collection('executorgroups').findOne({_id:tx.executorGroupId},{projection:{isApiBot:1},maxTimeMS:2000}):null;
            assertManual(tx,group);
        }else if(hash(tx)!==specs.find(row=>row.id===String(tx._id))?.digest)throw new Error('MANUAL_STATE_CHANGED');
        result.push({id:String(tx._id),digest:hash(tx)});
    }
    result.sort((a,b)=>a.id.localeCompare(b.id));
    return result.map(row=>row.id+':'+row.digest).join(',');
};
module.exports={assertManual,parseManifest,inspectManual};
