'use strict';
const { slots } = require('../utils/merchantWebhookOutboxSchema');
const fields = Object.values(slots);
const indexName = field => field + '_pending';
const indexesReady = async () => {
    try {
        const rows=await require('../models/Transaction').collection.listIndexes({maxTimeMS:1500}).toArray();
        return fields.every(field=>rows.some(row=>row.name===indexName(field) && row.key?.[field+'.pending']===1));
    } catch (_) { return false; }
};
// Explicit migration entry point only. Never called during application startup.
const ensureIndexes = async () => {
    for (const field of fields) await require('../models/Transaction').collection.createIndex(
        {[field+'.pending']:1,_id:1}, {name:indexName(field),partialFilterExpression:{[field+'.pending']:true}},
    );
};
const hasDurableEvent = async (type, tx) => {
    const field=slots[type.replace('transfer.','')];
    return Boolean(field && tx?._id && await require('../models/Transaction').exists({_id:tx._id,[field+'.eventId']:{$exists:true}}));
};
const drain = async (limit=25) => {
    if (!await indexesReady()) return {ready:false,staged:0,failed:0};
    const Transaction=require('../models/Transaction');
    const result={ready:true,staged:0,failed:0};
    for (const field of fields) {
        const rows=await Transaction.find({[field+'.pending']:true}).select('_id +'+field)
            .hint(indexName(field)).limit(Math.max(1,Math.min(100,limit))).maxTimeMS(2000).lean();
        for(const row of rows) {
            const item=row[field];
            try {
                await require('./merchantWebhookService').enqueueTransactionWebhook(item.eventType,item.source,{
                    eventId:item.eventId,payload:item.payload,dispatch:false,
                });
                // The payload UUID fences a concurrent replacement of the same lifecycle slot.
                await Transaction.updateOne({_id:row._id,[field+'.pending']:true,[field+'.payload.id']:item.payload.id},
                    {$set:{[field+'.pending']:false,[field+'.processedAt']:new Date()}},{timestamps:false});
                result.staged++;
            } catch (_) { result.failed++; }
        }
    }
    return result;
};
const queueStats = async (owner=null) => {
    const unavailable={available:false,pendingEvents:null,pendingDeliveries:null,oldestAgeSeconds:null,delayed:false};
    if(!await indexesReady())return unavailable;
    const now=new Date(),threshold=120;
    try {
        const multi=require('../middlewares/tenantResolver').tenantMode()==='multi';
        const scopedSource=field=>{
            if(!owner)return {};
            const source=field+'.source.';
            const ids=[owner.ownerId,String(owner.ownerId)];
            const scope=owner.ownerModel==='ClientCompany'?{[source+'companyId']:owner.ownerId}
                : owner.ownerModel==='User'?{[source+'companyId']:null,$or:[
                    {[source+'clientActorModel']:'User',[source+'clientActorId']:{$in:ids}},
                    {$and:[
                        {$or:[{[source+'clientActorModel']:{$ne:'User'}},{[source+'clientActorId']:{$in:[null,'']}}]},
                        {[source+'userId']:{$in:[String(owner.ownerId),...(owner.identifiers||[])].filter(Boolean)}}
                    ]}
                ]}:null;
            if(!scope)throw Error('OWNER_REQUIRED');
            if(multi)scope[source+'tenantId']=owner.tenantId||{$in:[]};return scope;
        };
        const parts=await Promise.all(fields.map(field=>require('../models/Transaction').aggregate([
            {$match:{[field+'.pending']:true,...scopedSource(field)}},
            {$group:{_id:null,count:{$sum:1},oldest:{$min:'$'+field+'.stagedAt'}}}
        ]).hint(indexName(field)).option({maxTimeMS:750})));
        const deliveryScope=owner?{ownerModel:owner.ownerModel,ownerId:owner.ownerId,...(multi?{tenantId:owner.tenantId||{$in:[]}}:{})}:{};
        const deliveries=await require('../models/MerchantWebhookDelivery').aggregate([
            {$match:{...deliveryScope,$or:[{status:{$in:['pending','sending']}},{status:'failed',nextAttemptAt:{$lte:now},attemptCount:{$lt:6}}]}},
            {$group:{_id:null,count:{$sum:1},oldest:{$min:{$cond:[{$eq:['$status','failed']},'$nextAttemptAt',{$cond:[{$eq:['$status','sending']},{$ifNull:['$lockedAt','$lastAttemptAt']},'$createdAt']}]}}}}
        ]).option({maxTimeMS:750});
        const summaries=parts.flat();const all=[...summaries,...deliveries];
        const dates=all.map(row=>row.oldest).filter(Boolean).map(value=>new Date(value).getTime()).filter(Number.isFinite);
        const oldest=dates.length?Math.min(...dates):null;
        const age=oldest===null?0:Math.max(0,Math.floor((now.getTime()-oldest)/1000));
        return {available:true,pendingEvents:summaries.reduce((sum,row)=>sum+row.count,0),pendingDeliveries:deliveries[0]?.count||0,
            oldestPendingAt:oldest===null?null:new Date(oldest).toISOString(),oldestAgeSeconds:age,warningAfterSeconds:threshold,delayed:age>=threshold};
    }catch(_){return unavailable;}
};
module.exports={indexesReady,ensureIndexes,hasDurableEvent,drain,queueStats};
