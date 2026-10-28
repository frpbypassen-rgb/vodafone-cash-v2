'use strict';
// Receiver reference implementation: mirrors delivery state only, never executes a payment.
const crypto=require('node:crypto');
const express=require('express');
const fault=(code,status)=>Object.assign(new Error(code),{status});
const createReceiver=({connection,secret,receiverId})=>{
    if(!connection || typeof secret!=='string' || secret.length<24 || !receiverId) throw new Error('RECEIVER_CONFIGURATION_REQUIRED');
    const Schema=connection.base.Schema;
    const inboxSchema=new Schema({receiverId:String,eventId:String,bodyHash:String,transactionId:String,ignored:Boolean,receivedAt:Date});
    inboxSchema.index({receiverId:1,eventId:1},{unique:true});
    const stateSchema=new Schema({receiverId:String,transactionId:String,status:String,appliedCount:{type:Number,default:0},updatedAt:Date});
    stateSchema.index({receiverId:1,transactionId:1},{unique:true});
    const Inbox=connection.models.MerchantReceiverInbox || connection.model('MerchantReceiverInbox',inboxSchema);
    const State=connection.models.MerchantReceiverState || connection.model('MerchantReceiverState',stateSchema);
    let ready=false;
    const ensureIndexes=async()=>{await Promise.all([Inbox.createIndexes(),State.createIndexes()]);ready=true;};
    const terminal=status=>['completed','rejected','cancelled','canceled','cancelled_by_admin','failed'].includes(status);
    const validate=(body)=>{
        if(!body || typeof body.id!=='string' || !body.id.length || body.id.length>180
            || !['transfer.created','transfer.completed','transfer.cancelled'].includes(body.type)
            || !/^[a-f\d]{24}$/i.test(body.data?.transaction_id || '')
            || typeof body.data?.status!=='string') throw fault('INVALID_EVENT',400);
        if(!['pending','accepted','processing','completed','rejected','cancelled','canceled','cancelled_by_admin','failed'].includes(body.data.status))throw fault('INVALID_EVENT',400);
        if(body.type==='transfer.completed' && body.data.status!=='completed')throw fault('INVALID_EVENT',400);
        if(body.type==='transfer.cancelled' && !['rejected','cancelled','canceled','cancelled_by_admin','failed'].includes(body.data.status))throw fault('INVALID_EVENT',400);
    };
    const apply=async(body,bodyHash)=>{
        for(let attempt=0;attempt<8;attempt++) {
            const session=await connection.startSession();let result;
            try {
                await session.withTransaction(async()=>{
                    const existing=await Inbox.findOne({receiverId,eventId:body.id}).session(session).lean();
                    if(existing) {
                        if(existing.bodyHash!==bodyHash)throw fault('EVENT_ID_CONFLICT',409);
                        result={received:true,duplicate:true};return;
                    }
                    const key={receiverId,transactionId:body.data.transaction_id};
                    const current=await State.findOne(key).session(session).lean();
                    const next=body.type==='transfer.created'
                        ? (['pending','accepted','processing'].includes(body.data.status)?body.data.status:'pending') : body.data.status;
                    const cancelled=status=>terminal(status)&&status!=='completed';
                    if(current&&terminal(current.status)&&terminal(next)
                        && current.status!==next && !(cancelled(current.status)&&cancelled(next)))throw fault('TERMINAL_STATE_CONFLICT',409);
                    const ranks={pending:1,accepted:2,processing:3};
                    const ignored=Boolean(current && (terminal(current.status)
                        || (!terminal(next)&&(ranks[next]||0)<=(ranks[current.status]||0))));
                    if(!ignored) await State.updateOne(key,{$set:{status:next,updatedAt:new Date()},$inc:{appliedCount:1}},{upsert:true,session});
                    await Inbox.create([{receiverId,eventId:body.id,bodyHash,transactionId:body.data.transaction_id,ignored,receivedAt:new Date()}],{session});
                    result={received:true,duplicate:false,ignored};
                });
                return result;
            } catch(error) {
                if(error.code===11000 && attempt<7)continue;
                throw error;
            } finally { await session.endSession(); }
        }
        throw fault('RECEIVER_BUSY',503);
    };
    const router=express.Router();
    router.post('/webhook',express.raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
        try {
            if(!ready)throw fault('RECEIVER_NOT_READY',503);
            const timestamp=req.get('x-ahrampay-timestamp')||'', signature=req.get('x-ahrampay-signature')||'';
            if(!Buffer.isBuffer(req.body) || !/^\d{10,12}$/.test(timestamp)
                || Math.abs(Date.now()/1000-Number(timestamp))>300 || !/^sha256=[a-f\d]{64}$/.test(signature))throw fault('INVALID_SIGNATURE',401);
            const expected=crypto.createHmac('sha256',secret).update(timestamp+'.').update(req.body).digest();
            if(!crypto.timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')))throw fault('INVALID_SIGNATURE',401);
            let body;try{body=JSON.parse(req.body.toString('utf8'));}catch(_){throw fault('INVALID_EVENT',400);}
            // Connection tests are authenticated but never mutate a transfer's mirrored state.
            if(body?.test===true) {
                if(body.type!=='transfer.created'||typeof body.data?.message!=='string')throw fault('INVALID_EVENT',400);
                return res.json({received:true,test:true});
            }
            validate(body);
            const result=await apply(body,crypto.createHash('sha256').update(req.body).digest('hex'));
            return res.json(result);
        } catch(error) {return res.status(error.status||503).json({received:false,code:error.status?error.message:'RECEIVER_UNAVAILABLE'});}
    });
    return {router,ensureIndexes,Inbox,State};
};
module.exports={createReceiver};
