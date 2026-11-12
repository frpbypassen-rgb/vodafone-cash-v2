'use strict';
const path = require('path');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Message = require('../models/ExecutorTeamMessage');
const ReadState = require('../models/ExecutorTeamReadState');
const Notification = require('../models/Notification');
const support = require('./executorSupportService');
const logger = require('../utils/logger');
const id = value => String(value?._id || value || '');
const fail = (code, message, status = 400) => new support.ExecutorSupportError(code, message, status);
const normalizeDigits = value => String(value || '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776));
const mask = value => { const text = String(value || ''); return text ? `••••${text.slice(-4)}` : ''; };
const operationDto = tx => ({id:id(tx),customId:tx.customId || '',amount:Number(tx.amount || 0),status:tx.status || '',transferType:tx.transferType || '',recipient:mask(tx.vodafoneNumber || tx.accountNumber),createdAt:tx.createdAt || null});
const transactionScope = support.buildLinkedTransactionScope;

async function operations({executorId, search = '', before = ''}) {
    const {employee} = await support.getExecutorIdentity(executorId);
    const filters = [transactionScope(employee)];
    const term = normalizeDigits(search).trim().slice(0,80);
    if (term) {
        const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
        const fields = [{customId:pattern},{vodafoneNumber:pattern},{accountNumber:pattern}];
        if (/^\d+(?:\.\d+)?$/.test(term)) fields.push({amount:Number(term)});
        filters.push({$or:fields});
    }
    if (before) {
        if (!mongoose.isValidObjectId(before)) throw fail('INVALID_CURSOR','مؤشر الصفحة غير صالح.');
        filters.push({_id:{$lt:before}});
    }
    const rows = await Transaction.find({$and:filters})
        .select('_id customId amount status transferType vodafoneNumber accountNumber createdAt')
        .sort({_id:-1}).limit(21).lean();
    return {operations:rows.slice(0,20).map(operationDto),nextCursor:rows.length>20?id(rows[19]):null};
}
async function members(groupId) {
    return Employee.find({groupId,status:'active'}).select('_id name webUsername role').lean();
}
const serialize = row => ({id:id(row),sender:'user',senderId:id(row.senderId),senderName:row.senderName,
    text:row.text || '',imageUrl:row.imageUrl || '',mentions:row.mentions || [],linkedOperation:row.linkedOperation || null,createdAt:row.createdAt});
async function unreadFor(employee) {
    const state = await ReadState.findOne({groupId:employee.groupId,employeeId:employee._id}).lean();
    return Message.countDocuments({groupId:employee.groupId,senderId:{$ne:employee._id},createdAt:{$gt:state?.lastReadAt || new Date(0)}});
}
async function unread({executorId}) {
    const {employee} = await support.getExecutorIdentity(executorId);
    return {unreadCount:await unreadFor(employee)};
}
async function conversation({executorId,before=''}) {
    const {employee,group} = await support.getExecutorIdentity(executorId);
    const filter = {groupId:group._id};
    if (before) {
        if (!mongoose.isValidObjectId(before)) throw fail('INVALID_CURSOR','مؤشر الصفحة غير صالح.');
        filter._id = {$lt:before};
    }
    const [rows,people] = await Promise.all([Message.find(filter).sort({_id:-1}).limit(101).lean(),members(group._id)]);
    const page = rows.slice(0,100).reverse();
    if (!before && page.length) {
        const cursor={groupId:group._id,employeeId:employee._id};
        try { await ReadState.updateOne(cursor,{$max:{lastReadAt:page[page.length-1].createdAt}},{upsert:true}); }
        catch(error) { if(error.code!==11000) throw error; await ReadState.updateOne(cursor,{$max:{lastReadAt:page[page.length-1].createdAt}}); }
    }
    return {ticket:{id:`team:${id(group)}`,messages:page.map(serialize)},
        members:people.map(person=>({id:id(person),name:person.name || person.webUsername || 'موظف',role:person.role})),
        nextCursor:rows.length>100?id(page[0]):null,unreadCount:0};
}
async function send({executorId,payload={}}) {
    const {employee,group} = await support.getExecutorIdentity(executorId);
    const text=String(payload.message || '').trim().slice(0,2000);
    const requested = Array.isArray(payload.mentionIds) ? [...new Set(payload.mentionIds.map(String))] : [];
    if(requested.length>10 || requested.some(value=>!mongoose.isValidObjectId(value))) throw fail('INVALID_MENTIONS','الإشارات غير صالحة.');
    const people=requested.length?await Employee.find({_id:{$in:requested},groupId:group._id,status:'active'}).select('_id name webUsername').lean():[];
    if(people.length!==requested.length) throw fail('INVALID_MENTIONS','يمكن الإشارة لأعضاء الشركة النشطين فقط.',403);
    const mentions=people.filter(person=>text.includes(`@${person.name || person.webUsername}`)).map(person=>({id:id(person),name:person.name || person.webUsername}));
    const operation=payload.transactionRef?await support.resolveLinkedTransaction({employee,transactionRef:payload.transactionRef}):null;
    if(!text && !operation && !(payload.imagesBase64 || []).length) throw fail('VALIDATION_ERROR','اكتب رسالة أو أرفق عملية أو صورة.');
    const images=await support.saveSupportImages(payload.imagesBase64 || []);
    if(!text && !operation && !images.length) throw fail('VALIDATION_ERROR','اكتب رسالة أو أرفق عملية أو صورة.');
    const common={groupId:group._id,senderId:employee._id,senderName:employee.name || employee.webUsername || 'موظف',createdAt:new Date()};
    const records=[];
    if(text || operation) records.push({...common,text,mentions,linkedOperation:operation?{...operation,recipient:mask(operation.recipient)}:undefined});
    for(const imageUrl of images) records.push({...common,imageUrl});
    const saved=await Message.insertMany(records);
    await Promise.all(people.filter(person=>id(person)!==id(employee) && mentions.some(m=>m.id===id(person))).map(person=>Notification.create({
        audience:'executor',userId:person.webUsername || id(person),targetModel:'Employee',targetId:person._id,
        tenantId:group.tenantId || employee.tenantId,type:'team_mention',title:'إشارة إليك في جروب الشركة',
        message:`${common.senderName} أشار إليك في محادثة الفريق.`,metadata:{groupId:id(group),messageId:id(saved[0]),destination:'team-chat'}
    }).catch(error=>logger.error('Team mention notification failed',{code:error.code || 'NOTIFICATION_FAILED'}))));
    // A failed refresh must not turn an already persisted send into a failed POST.
    try { return await conversation({executorId}); }
    catch(error) { logger.error('Team chat refresh after send failed',{code:error.code || 'REFRESH_FAILED'});
        return {ticket:{id:`team:${id(group)}`,messages:saved.map(serialize)},partial:true}; }
}
async function image({executorId,messageId}) {
    const {group}=await support.getExecutorIdentity(executorId);
    if(!mongoose.isValidObjectId(messageId)) throw fail('NOT_FOUND','المرفق غير موجود.',404);
    const row=await Message.findOne({_id:messageId,groupId:group._id}).lean();
    const source=String(row?.imageUrl || '');
    if(!/^\/uploads\/support\/[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp)$/i.test(source)) throw fail('NOT_FOUND','المرفق غير موجود.',404);
    return path.join(process.cwd(),'uploads','support',path.basename(source));
}
module.exports={operations,unread,conversation,send,image,transactionScope,normalizeDigits};
