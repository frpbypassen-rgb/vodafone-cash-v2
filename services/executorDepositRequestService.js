'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const SupportTicket = require('../models/SupportTicket');
const Transaction = require('../models/Transaction');
const { syncBotBalance } = require('../utils/helpers');

const MAX_RECEIPTS = 5;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const objectId = (value) => String(value?._id || value || '');

function parseReceipt(value) {
    const match = String(value || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
    if (!match) throw failure('صيغة أحد الإيصالات غير صالحة. استخدم JPG أو PNG أو WEBP.');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_RECEIPT_BYTES) throw failure('حجم كل إيصال يجب ألا يتجاوز 5 ميجابايت.');
    return { buffer, ext: IMAGE_TYPES[match[1].toLowerCase()] };
}

function saveReceipts(receipts, reference) {
    const items = Array.isArray(receipts) ? receipts.filter(Boolean) : [];
    if (!items.length) throw failure('أرفق إيصال إيداع واحدًا على الأقل.');
    if (items.length > MAX_RECEIPTS) throw failure(`يمكن إرفاق ${MAX_RECEIPTS} إيصالات كحد أقصى.`);
    const destination = path.join(process.cwd(), 'uploads', 'proofs');
    fs.mkdirSync(destination, { recursive: true });
    return items.map((item, index) => {
        const { buffer, ext } = parseReceipt(item);
        const filename = `${reference}_deposit_${index + 1}_${crypto.randomBytes(5).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(destination, filename), buffer);
        return `proofs/${filename}`;
    });
}

function depositMessage({ group, employee, amount, note, customId }) {
    return `طلب إيداع لشركة التنفيذ\nرقم الطلب: ${customId}\nالشركة: ${group.name}\nمقدم الطلب: ${employee.name}\nالقيمة: ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} EGP\nالملاحظة: ${note || 'لا توجد ملاحظة'}`;
}

async function notifyAdmins({ title, message, type = 'deposit_pending' }) {
    const admins = await Admin.find({}).select('webUsername').lean();
    await Promise.all(admins.map((admin) => Notification.create({
        userId: admin.webUsername || 'admin', title, message, type
    }).catch(() => null)));
}

async function createDepositRequest({ employee, amount, note, receipts }) {
    if (!employee?.groupId || employee.role !== 'manager') throw failure('طلب إيداع الشركة متاح لمدير شركة التنفيذ فقط.', 403);
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1000000) throw failure('قيمة الإيداع غير صالحة.');
    const cleanNote = String(note || '').replace(/\u0000/g, '').trim().slice(0, 1000);
    const group = employee.groupId;
    const customId = `DEPREQ-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const receiptImages = saveReceipts(receipts, customId);
    const createdAt = new Date();

    const tx = await Transaction.create({
        userId: 'admin', executorGroupId: group._id, managerGroupId: group.isManagerGroup ? group._id : undefined,
        operatorId: objectId(employee._id), amount: parsedAmount, costLYD: 0, vodafoneNumber: 'طلب إيداع شركة تنفيذ',
        status: 'deposit_pending', customId, companyName: group.name || 'شركة التنفيذ', employeeName: employee.name,
        executorName: employee.name, notes: cleanNote, proofImage: receiptImages[0], proofImages: receiptImages,
        depositRequest: { note: cleanNote, receiptImages, submittedById: employee._id, submittedByName: employee.name }
    });

    const messages = [{ sender: 'user', senderName: employee.name, text: depositMessage({ group, employee, amount: parsedAmount, note: cleanNote, customId }), channel: 'portal', direction: 'inbound', messageType: 'text', createdAt }];
    receiptImages.forEach((image) => messages.push({ sender: 'user', senderName: employee.name, text: '', imageUrl: `/uploads/${image}`, channel: 'portal', direction: 'inbound', messageType: 'image', createdAt }));
    const ticket = await SupportTicket.create({
        entityType: 'executor_group', entityId: group._id, name: group.name || 'شركة التنفيذ', phone: employee.phone || '',
        channel: 'portal', status: 'open', priority: 'high', category: 'deposit', unreadAdmin: 1, unreadUser: 0, messages,
        metadata: { type: 'executor_deposit', subject: `طلب إيداع ${customId}`, executorGroupId: objectId(group._id), executorGroupName: group.name || '', depositRequest: { transactionId: objectId(tx._id), customId, amount: parsedAmount, note: cleanNote, receiptCount: receiptImages.length, status: 'pending' } }
    });
    tx.depositRequest.supportTicketId = ticket._id;
    await tx.save();
    await notifyAdmins({ title: 'طلب إيداع جديد لشركة تنفيذ', message: `${group.name}: ${customId} بقيمة ${parsedAmount} EGP` });
    return { id: objectId(tx._id), customId, status: 'pending', receiptCount: receiptImages.length, createdAt };
}

async function listDepositRequests({ employee }) {
    if (!employee?.groupId) throw failure('جلسة شركة التنفيذ غير صالحة.', 401);
    const rows = await Transaction.find({ executorGroupId: employee.groupId._id, status: { $in: ['deposit_pending', 'deposit', 'rejected'] }, 'depositRequest.submittedById': { $exists: true } })
        .select('customId amount status createdAt updatedAt proofImages depositRequest executorWebAlert')
        .sort({ createdAt: -1 }).limit(100).lean();
    return rows.map((row) => ({
        id: objectId(row._id), customId: row.customId, amount: Number(row.amount || 0),
        status: row.status === 'deposit_pending' ? 'pending' : row.status,
        note: row.depositRequest?.note || '', rejectionReason: row.depositRequest?.rejectionReason || '',
        receiptCount: Array.isArray(row.proofImages) ? row.proofImages.length : 0,
        createdAt: row.createdAt, updatedAt: row.updatedAt
    }));
}

async function resolveDepositTicket({ ticketId, admin, approved, reason = '' }) {
    if (!mongoose.isValidObjectId(ticketId)) throw failure('طلب الدعم غير صالح.', 404);
    const ticket = await SupportTicket.findById(ticketId);
    const transactionId = ticket?.metadata?.type === 'executor_deposit' ? ticket.metadata?.depositRequest?.transactionId : null;
    if (!ticket || !mongoose.isValidObjectId(transactionId)) throw failure('طلب الإيداع غير موجود.', 404);
    const reviewedAt = new Date();
    const cleanReason = String(reason || '').trim().slice(0, 1000);
    if (!approved && cleanReason.length < 3) throw failure('اكتب سبب الرفض بوضوح.');
    const update = approved
        ? { status: 'deposit', 'depositRequest.reviewedById': admin.id, 'depositRequest.reviewedByName': admin.name, 'depositRequest.reviewedAt': reviewedAt, executorWebAlert: { type: 'success', text: `تم قبول طلب الإيداع ${ticket.metadata.depositRequest.customId} وإضافة ${ticket.metadata.depositRequest.amount} EGP إلى رصيد الشركة.`, imageUrl: '' } }
        : { status: 'rejected', 'depositRequest.reviewedById': admin.id, 'depositRequest.reviewedByName': admin.name, 'depositRequest.reviewedAt': reviewedAt, 'depositRequest.rejectionReason': cleanReason, executorWebAlert: { type: 'error', text: `تم رفض طلب الإيداع ${ticket.metadata.depositRequest.customId}. السبب: ${cleanReason}` } };
    const tx = await Transaction.findOneAndUpdate({ _id: transactionId, status: 'deposit_pending', 'depositRequest.supportTicketId': ticket._id }, { $set: update }, { new: true });
    if (!tx) throw failure('تمت مراجعة طلب الإيداع سابقًا أو لم يعد متاحًا.', 409);
    ticket.status = approved ? 'resolved' : 'closed';
    ticket.resolvedAt = approved ? reviewedAt : ticket.resolvedAt;
    ticket.closedAt = approved ? ticket.closedAt : reviewedAt;
    ticket.unreadUser = Number(ticket.unreadUser || 0) + 1;
    ticket.metadata.depositRequest.status = approved ? 'approved' : 'rejected';
    ticket.messages.push({ sender: 'admin', senderName: admin.name, text: approved ? `تم قبول الإيداع وإضافة ${tx.amount} EGP إلى رصيد الشركة.` : `تم رفض طلب الإيداع. السبب: ${cleanReason}`, channel: 'portal', direction: 'outbound', messageType: 'text', createdAt: reviewedAt });
    await ticket.save();
    if (approved) await syncBotBalance(tx.executorGroupId);
    return { transaction: tx, ticket };
}

module.exports = { createDepositRequest, listDepositRequests, resolveDepositTicket };
