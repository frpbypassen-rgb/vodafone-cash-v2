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
const isAdminInitiatedTicket = (ticket) => (
    ticket?.metadata?.depositRequest?.submittedByRole === 'admin'
    // Legacy tickets do not store submittedByRole. Their first message is the
    // creation event, unlike later support replies that may also be from admin.
    || ticket?.messages?.[0]?.sender === 'admin'
);

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

async function createDepositRequest({ employee, group: requestedGroup, submittedBy, amount, note, receipts, submittedFromAdmin = false }) {
    if ((!employee?.groupId && !requestedGroup) || (employee && employee.role === 'accountant')) throw failure('هذا الحساب لا يملك صلاحية طلب إيداع للشركة.', 403);
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1000000) throw failure('قيمة الإيداع غير صالحة.');
    const cleanNote = String(note || '').replace(/\u0000/g, '').trim().slice(0, 1000);
    const group = requestedGroup || employee.groupId;
    const submitter = submittedBy || {
        id: employee?._id,
        name: employee?.name || 'شركة التنفيذ',
        phone: employee?.phone || ''
    };
    const customId = `DEPREQ-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const receiptImages = saveReceipts(receipts, customId);
    const createdAt = new Date();

    const tx = await Transaction.create({
        userId: 'admin', executorGroupId: group._id, managerGroupId: group.isManagerGroup ? group._id : undefined,
        operatorId: objectId(submitter.id), amount: parsedAmount, costLYD: 0, vodafoneNumber: 'طلب إيداع شركة تنفيذ',
        status: 'deposit_pending', customId, companyName: group.name || 'شركة التنفيذ', employeeName: submitter.name,
        executorName: submitter.name, notes: cleanNote, proofImage: receiptImages[0], proofImages: receiptImages,
        executorWebAlert: submittedFromAdmin ? { type: 'warning', text: `تم تسجيل طلب إيداع إداري ${customId} بقيمة ${parsedAmount} EGP وهو قيد المراجعة.` } : undefined,
        depositRequest: { note: cleanNote, receiptImages, submittedById: submitter.id, submittedByName: submitter.name, submittedByRole: submittedFromAdmin ? 'admin' : 'executor' }
    });

    const messageActor = { name: submitter.name };
    const messageSender = submittedFromAdmin ? 'admin' : 'user';
    const messageDirection = submittedFromAdmin ? 'outbound' : 'inbound';
    const messages = [{ sender: messageSender, senderName: submitter.name, text: depositMessage({ group, employee: messageActor, amount: parsedAmount, note: cleanNote, customId }), channel: 'portal', direction: messageDirection, messageType: 'text', createdAt }];
    receiptImages.forEach((image) => messages.push({ sender: messageSender, senderName: submitter.name, text: '', imageUrl: `/uploads/${image}`, channel: 'portal', direction: messageDirection, messageType: 'image', createdAt }));
    const ticket = await SupportTicket.create({
        entityType: 'executor_group', entityId: group._id, name: group.name || 'شركة التنفيذ', phone: submitter.phone || '',
        channel: 'portal', status: 'open', priority: 'high', category: 'deposit', unreadAdmin: 1, unreadUser: 0, messages,
        metadata: {
            type: 'executor_deposit',
            subject: `طلب إيداع ${customId}`,
            executorGroupId: objectId(group._id),
            executorGroupName: group.name || '',
            depositRequest: {
                transactionId: objectId(tx._id),
                customId,
                amount: parsedAmount,
                note: cleanNote,
                receiptCount: receiptImages.length,
                receiptImages,
                submittedByName: submitter.name,
                submittedByRole: submittedFromAdmin ? 'admin' : 'executor',
                status: 'pending'
            }
        }
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
    const toReceiptUrl = (imagePath) => {
        const value = String(imagePath || '').trim();
        if (!value) return '';
        if (value.startsWith('http') || value.startsWith('/')) return value;
        return `/uploads/${value.replace(/^\/+/, '')}`;
    };

    const ticketIds = rows.map((row) => row.depositRequest?.supportTicketId).filter(Boolean);
    const tickets = ticketIds.length
        ? await SupportTicket.find({ _id: { $in: ticketIds } }).select('messages.sender metadata.depositRequest.submittedByRole').lean()
        : [];
    const submittedRoles = new Map(tickets.map((ticket) => [objectId(ticket._id), isAdminInitiatedTicket(ticket) ? 'admin' : 'executor']));

    return rows.map((row) => {
        const proofImages = Array.isArray(row.proofImages) ? row.proofImages : [];
        return {
            id: objectId(row._id),
            customId: row.customId,
            amount: Number(row.amount || 0),
            status: row.status === 'deposit_pending' ? 'pending' : row.status,
            note: row.depositRequest?.note || '',
            rejectionReason: row.depositRequest?.rejectionReason || '',
            receiptCount: proofImages.length,
            receiptUrls: proofImages.map(toReceiptUrl).filter(Boolean),
            submittedByRole: row.depositRequest?.submittedByRole || submittedRoles.get(objectId(row.depositRequest?.supportTicketId)) || 'executor',
            reviewedByName: row.depositRequest?.reviewedByName || '',
            reviewedAt: row.depositRequest?.reviewedAt || null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    });
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
    ticket.metadata.depositRequest.reviewedById = admin.id;
    ticket.metadata.depositRequest.reviewedByName = admin.name;
    ticket.metadata.depositRequest.reviewedAt = reviewedAt;
    if (!approved) ticket.metadata.depositRequest.rejectionReason = cleanReason;
    ticket.messages.push({ sender: 'admin', senderName: admin.name, text: approved ? `تم قبول الإيداع وإضافة ${tx.amount} EGP إلى رصيد الشركة.` : `تم رفض طلب الإيداع. السبب: ${cleanReason}`, channel: 'portal', direction: 'outbound', messageType: 'text', createdAt: reviewedAt });
    await ticket.save();
    if (approved) await syncBotBalance(tx.executorGroupId);
    return { transaction: tx, ticket };
}

async function reviewAdminDepositRequest({ employee, requestId, approved, reason = '' }) {
    if (!employee?.groupId || employee.role !== 'manager') throw failure('الموافقة على إيداعات الإدارة متاحة لمدير شركة التنفيذ فقط.', 403);
    if (!mongoose.isValidObjectId(requestId)) throw failure('طلب الإيداع غير صالح.', 404);
    const tx = await Transaction.findOne({ _id: requestId, executorGroupId: employee.groupId._id, status: 'deposit_pending' }).select('depositRequest');
    if (!tx?.depositRequest?.supportTicketId) throw failure('هذا الطلب غير متاح للمراجعة أو تمت مراجعته سابقًا.', 404);
    const ticket = await SupportTicket.findById(tx.depositRequest.supportTicketId).select('messages.sender metadata.depositRequest.submittedByRole').lean();
    if (tx.depositRequest.submittedByRole !== 'admin' && !isAdminInitiatedTicket(ticket)) {
        throw failure('هذا الطلب ليس إيداعاً واردًا من الإدارة.', 403);
    }
    if (tx.depositRequest.submittedByRole !== 'admin') {
        await Transaction.updateOne({ _id: tx._id }, { $set: { 'depositRequest.submittedByRole': 'admin' } });
    }
    return resolveDepositTicket({ ticketId: String(tx.depositRequest.supportTicketId), admin: { id: objectId(employee._id), name: employee.name }, approved, reason });
}

module.exports = { createDepositRequest, listDepositRequests, resolveDepositTicket, reviewAdminDepositRequest };
