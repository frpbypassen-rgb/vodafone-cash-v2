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
module.exports={indexesReady,ensureIndexes,hasDurableEvent,drain};
