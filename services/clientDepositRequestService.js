'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const SupportTicket = require('../models/SupportTicket');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { updateBalanceWithLedger } = require('./walletService');
const { createClientNotifications, notifyBalanceAdjustment } = require('./clientNotificationService');

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const objectId = (value) => String(value?._id || value || '');

async function notifyAdmins({ title, message, type = 'deposit_pending' }) {
    const admins = await Admin.find({}).select('webUsername').lean();
    await Promise.all(admins.map((admin) => Notification.create({
        userId: admin.webUsername || 'admin', title, message, type
    }).catch(() => null)));
}

function clientUserKey(client) {
    return client?.phone || client?.webUsername || objectId(client?._id);
}

function depositMessage({ client, amount, note, customId }) {
    return `طلب إيداع رصيد\nرقم الطلب: ${customId}\nالعميل: ${client.name || 'عميل مباشر'}\nالقيمة: ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} LYD\nالملاحظة: ${note || 'لا توجد ملاحظة'}`;
}

async function createClientDepositRequest({ client, amount, note }) {
    if (!client || client.role === 'agent') throw failure('هذا الحساب لا يمكنه طلب إيداع من هذه الشاشة.', 403);

    const userKey = clientUserKey(client);
    const pending = await Transaction.findOne({
        userId: userKey,
        status: 'deposit_pending',
        'depositRequest.submittedByRole': 'client'
    }).select('_id customId').lean();
    if (pending) {
        throw failure(`لديك طلب إيداع قيد المراجعة (${pending.customId}). انتظر قرار الإدارة قبل إرسال طلب جديد.`, 409);
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1000000) {
        throw failure('قيمة الإيداع غير صالحة.');
    }

    const cleanNote = String(note || '').replace(/\u0000/g, '').trim().slice(0, 1000);
    if (cleanNote.length < 3) throw failure('اكتب ملاحظة توضح تفاصيل الإيداع (مرجع التحويل أو البنك).', 400);

    const customId = `CLDEP-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const createdAt = new Date();

    const tx = await Transaction.create({
        userId: userKey,
        amount: parsedAmount,
        costLYD: 0,
        vodafoneNumber: 'طلب إيداع عميل',
        status: 'deposit_pending',
        customId,
        companyName: client.name || 'عميل مباشر',
        employeeName: client.name || 'عميل مباشر',
        notes: cleanNote,
        depositRequest: {
            note: cleanNote,
            receiptImages: [],
            submittedById: client._id,
            submittedByName: client.name || 'عميل مباشر',
            submittedByRole: 'client'
        }
    });

    const ticket = await SupportTicket.create({
        entityType: 'client_user',
        entityId: client._id,
        telegramId: client.phone || client.webUsername,
        name: client.name || 'عميل مباشر',
        phone: client.phone || '',
        channel: 'portal',
        status: 'open',
        priority: 'high',
        category: 'deposit',
        unreadAdmin: 1,
        unreadUser: 0,
        messages: [{
            sender: 'user',
            senderName: client.name || 'عميل مباشر',
            text: depositMessage({ client, amount: parsedAmount, note: cleanNote, customId }),
            channel: 'portal',
            direction: 'inbound',
            messageType: 'text',
            createdAt
        }],
        metadata: {
            type: 'client_deposit',
            subject: `طلب إيداع ${customId}`,
            clientUserId: objectId(client._id),
            clientName: client.name || '',
            depositRequest: {
                transactionId: objectId(tx._id),
                customId,
                amount: parsedAmount,
                note: cleanNote,
                receiptCount: 0,
                receiptImages: [],
                submittedByName: client.name || 'عميل مباشر',
                submittedByRole: 'client',
                status: 'pending'
            }
        }
    });

    tx.depositRequest.supportTicketId = ticket._id;
    await tx.save();

    await notifyAdmins({
        title: 'طلب إيداع جديد من عميل مباشر',
        message: `${client.name || userKey}: ${customId} بقيمة ${parsedAmount} LYD`
    });

    return {
        id: objectId(tx._id),
        customId,
        status: 'pending',
        amount: parsedAmount,
        createdAt
    };
}

async function listClientDepositRequests({ client }) {
    const userKey = clientUserKey(client);
    const rows = await Transaction.find({
        userId: userKey,
        'depositRequest.submittedByRole': 'client',
        status: { $in: ['deposit_pending', 'deposit', 'rejected'] }
    })
        .select('customId amount status createdAt updatedAt depositRequest notes')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

    return rows.map((row) => ({
        id: objectId(row._id),
        customId: row.customId,
        amount: Number(row.amount || 0),
        status: row.status === 'deposit_pending' ? 'pending' : row.status,
        note: row.depositRequest?.note || row.notes || '',
        rejectionReason: row.depositRequest?.rejectionReason || '',
        reviewedByName: row.depositRequest?.reviewedByName || '',
        reviewedAt: row.depositRequest?.reviewedAt || null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    }));
}

async function resolveClientDepositTicket({ ticketId, admin, approved, reason = '' }) {
    if (!mongoose.isValidObjectId(ticketId)) throw failure('طلب الدعم غير صالح.', 404);

    const ticket = await SupportTicket.findById(ticketId);
    const transactionId = ticket?.metadata?.type === 'client_deposit'
        ? ticket.metadata?.depositRequest?.transactionId
        : null;
    if (!ticket || !mongoose.isValidObjectId(transactionId)) throw failure('طلب الإيداع غير موجود.', 404);

    const reviewedAt = new Date();
    const cleanReason = String(reason || '').trim().slice(0, 1000);
    if (!approved && cleanReason.length < 3) throw failure('اكتب سبب الرفض بوضوح.');

    const tx = await Transaction.findOne({
        _id: transactionId,
        status: 'deposit_pending',
        'depositRequest.supportTicketId': ticket._id,
        'depositRequest.submittedByRole': 'client'
    });
    if (!tx) throw failure('تمت مراجعة طلب الإيداع سابقًا أو لم يعد متاحًا.', 409);

    const client = await User.findOne({
        $or: [
            { phone: tx.userId },
            { webUsername: tx.userId },
            { _id: tx.depositRequest?.submittedById }
        ]
    });
    if (!client) throw failure('تعذر العثور على حساب العميل.', 404);

    if (approved) {
        const balanceResult = await updateBalanceWithLedger(
            'User',
            client._id,
            tx.amount,
            'DEPOSIT',
            tx.customId,
            `إيداع معتمد ${tx.customId}`
        );
        tx.status = 'deposit';
        tx.balanceAdjustment = {
            entityModel: 'User',
            entityId: client._id,
            delta: tx.amount,
            reversible: true
        };
        tx.depositRequest.reviewedById = admin.id;
        tx.depositRequest.reviewedByName = admin.name;
        tx.depositRequest.reviewedAt = reviewedAt;
        await tx.save();

        await notifyBalanceAdjustment({
            accountModel: 'User',
            account: client,
            amount: tx.amount,
            balanceAfter: balanceResult.balanceAfter,
            customId: tx.customId,
            notes: tx.depositRequest?.note || ''
        }).catch(() => null);
    } else {
        tx.status = 'rejected';
        tx.depositRequest.reviewedById = admin.id;
        tx.depositRequest.reviewedByName = admin.name;
        tx.depositRequest.reviewedAt = reviewedAt;
        tx.depositRequest.rejectionReason = cleanReason;
        await tx.save();

        await createClientNotifications({
            accountModel: 'User',
            account: client,
            title: 'تم رفض طلب الإيداع',
            message: `تم رفض طلب الإيداع ${tx.customId}. السبب: ${cleanReason}`,
            type: 'deposit_pending',
            txId: tx.customId
        }).catch(() => null);
    }

    ticket.status = approved ? 'resolved' : 'closed';
    ticket.resolvedAt = approved ? reviewedAt : ticket.resolvedAt;
    ticket.closedAt = approved ? ticket.closedAt : reviewedAt;
    ticket.unreadUser = Number(ticket.unreadUser || 0) + 1;
    ticket.metadata.depositRequest.status = approved ? 'approved' : 'rejected';
    ticket.metadata.depositRequest.reviewedById = admin.id;
    ticket.metadata.depositRequest.reviewedByName = admin.name;
    ticket.metadata.depositRequest.reviewedAt = reviewedAt;
    if (!approved) ticket.metadata.depositRequest.rejectionReason = cleanReason;
    ticket.messages.push({
        sender: 'admin',
        senderName: admin.name,
        text: approved
            ? `تم قبول طلب الإيداع وإضافة ${tx.amount} LYD إلى رصيدك.`
            : `تم رفض طلب الإيداع. السبب: ${cleanReason}`,
        channel: 'portal',
        direction: 'outbound',
        messageType: 'text',
        createdAt: reviewedAt
    });
    await ticket.save();

    return { transaction: tx, ticket };
}

module.exports = {
    createClientDepositRequest,
    listClientDepositRequests,
    resolveClientDepositTicket
};
