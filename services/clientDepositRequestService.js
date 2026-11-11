'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const SupportTicket = require('../models/SupportTicket');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const logger = require('../utils/logger');
const {
    updateBalanceWithLedger,
    isMongoTransactionFallbackError,
    financialTransactionsUnavailableError,
} = require('./walletService');
const { createClientNotifications, notifyBalanceAdjustment } = require('./clientNotificationService');

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const objectId = (value) => String(value?._id || value || '');
const runDepositTransaction = async (work) => {
    try {
        return await mongoose.connection.transaction(work);
    } catch (error) {
        if (isMongoTransactionFallbackError(error)) {
            throw Object.assign(financialTransactionsUnavailableError(error), { status: 503 });
        }
        throw error;
    }
};
const clientDepositScope = async (client, session = null) => {
    const ownedTicketIds = await SupportTicket.find({
        entityType: 'client_user',
        entityId: client._id,
        'metadata.type': 'client_deposit',
    })
        .distinct('_id')
        .session(session);
    return {
        $or: [
            { 'depositRequest.submittedById': client._id },
            {
                'depositRequest.submittedById': null,
                'depositRequest.supportTicketId': { $in: ownedTicketIds },
            },
        ],
    };
};

async function notifyAdmins({ title, message, type = 'deposit_pending' }) {
    const admins = await Admin.find({}).select('webUsername').lean();
    await Promise.all(
        admins.map((admin) =>
            Notification.create({
                userId: admin.webUsername || 'admin',
                title,
                message,
                type,
            }).catch(() => null)
        )
    );
}

function clientUserKey(client) {
    return client?.phone || client?.webUsername || objectId(client?._id);
}

function depositMessage({ client, amount, note, customId }) {
    return `طلب إيداع رصيد\nرقم الطلب: ${customId}\nالعميل: ${client.name || 'عميل مباشر'}\nالقيمة: ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} LYD\nالملاحظة: ${note || 'لا توجد ملاحظة'}`;
}

async function createClientDepositRequest({ client, amount, note }) {
    if (!client || client.role === 'agent')
        throw failure('هذا الحساب لا يمكنه طلب إيداع من هذه الشاشة.', 403);

    const userKey = clientUserKey(client);
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1000000) {
        throw failure('قيمة الإيداع غير صالحة.');
    }

    const cleanNote = String(note || '')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, 1000);
    if (cleanNote.length < 3) throw failure('اكتب ملاحظة توضح تفاصيل الإيداع (مرجع التحويل أو البنك).', 400);

    const customId = `CLDEP-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const createdAt = new Date();

    const tx = await runDepositTransaction(async (session) => {
        // Serialize submissions for one owner before checking their pending request.
        const owner = await User.updateOne(
            { _id: client._id, status: 'active' },
            { $currentDate: { updatedAt: true } },
            { session }
        );
        if (!owner.matchedCount) throw failure('حساب العميل غير متاح.', 403);
        const pending = await Transaction.findOne({
            ...(await clientDepositScope(client, session)),
            status: 'deposit_pending',
            'depositRequest.submittedByRole': 'client',
        })
            .session(session)
            .select('_id customId')
            .lean();
        if (pending)
            throw failure(
                `لديك طلب إيداع قيد المراجعة (${pending.customId}). انتظر قرار الإدارة قبل إرسال طلب جديد.`,
                409
            );
        const [created] = await Transaction.create(
            [
                {
                    tenantId: client.tenantId,
                    clientActorModel: 'User',
                    clientActorId: client._id,
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
                        submittedByRole: 'client',
                    },
                },
            ],
            { session }
        );

        const [ticket] = await SupportTicket.create(
            [
                {
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
                    messages: [
                        {
                            sender: 'user',
                            senderName: client.name || 'عميل مباشر',
                            text: depositMessage({ client, amount: parsedAmount, note: cleanNote, customId }),
                            channel: 'portal',
                            direction: 'inbound',
                            messageType: 'text',
                            createdAt,
                        },
                    ],
                    metadata: {
                        type: 'client_deposit',
                        subject: `طلب إيداع ${customId}`,
                        clientUserId: objectId(client._id),
                        clientName: client.name || '',
                        depositRequest: {
                            transactionId: objectId(created._id),
                            customId,
                            amount: parsedAmount,
                            note: cleanNote,
                            receiptCount: 0,
                            receiptImages: [],
                            submittedByName: client.name || 'عميل مباشر',
                            submittedByRole: 'client',
                            status: 'pending',
                        },
                    },
                },
            ],
            { session }
        );

        created.depositRequest.supportTicketId = ticket._id;
        await created.save({ session });
        return created;
    });

    await notifyAdmins({
        title: 'طلب إيداع جديد من عميل مباشر',
        message: `${client.name || userKey}: ${customId} بقيمة ${parsedAmount} LYD`,
    }).catch((error) => logger.warn('Client deposit notification failed after request commit', {
        event: 'client_deposit_notification_failed', customId, code: error.code || error.name,
    }));

    return {
        id: objectId(tx._id),
        customId,
        status: 'pending',
        amount: parsedAmount,
        createdAt,
    };
}

async function listClientDepositRequests({ client }) {
    const rows = await Transaction.find({
        ...(await clientDepositScope(client)),
        'depositRequest.submittedByRole': 'client',
        status: { $in: ['deposit_pending', 'deposit', 'rejected'] },
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
        updatedAt: row.updatedAt,
    }));
}

async function resolveClientDepositTicketInSession({ ticketId, admin, approved, reason = '', session }) {
    if (!mongoose.isValidObjectId(ticketId)) throw failure('طلب الدعم غير صالح.', 404);

    const ticket = await SupportTicket.findById(ticketId).session(session);
    const transactionId =
        ticket?.metadata?.type === 'client_deposit' ? ticket.metadata?.depositRequest?.transactionId : null;
    if (!ticket || !mongoose.isValidObjectId(transactionId)) throw failure('طلب الإيداع غير موجود.', 404);

    const reviewedAt = new Date();
    const reviewerId = String(admin?.id || '').trim();
    const reviewerName = String(admin?.name || '').trim();
    if (!reviewerId || !reviewerName) throw failure('تعذر تحديد المدير الذي راجع طلب الإيداع.', 401);
    const cleanReason = String(reason || '')
        .trim()
        .slice(0, 1000);
    if (!approved && cleanReason.length < 3) throw failure('اكتب سبب الرفض بوضوح.');

    const tx = await Transaction.findOneAndUpdate(
        {
            _id: transactionId,
            status: 'deposit_pending',
            'depositRequest.supportTicketId': ticket._id,
            'depositRequest.submittedByRole': 'client',
        },
        { $set: { status: approved ? 'deposit' : 'rejected' } },
        { returnDocument: 'after', session }
    );
    if (!tx) throw failure('تمت مراجعة طلب الإيداع سابقًا أو لم يعد متاحًا.', 409);
    if (!Number.isFinite(tx.amount) || tx.amount <= 0) throw failure('قيمة الإيداع غير صالحة.', 409);

    const clientId = tx.depositRequest?.submittedById || ticket.entityId;
    if (
        ticket.entityType !== 'client_user' ||
        objectId(ticket.entityId) !== objectId(clientId) ||
        (ticket.metadata.clientUserId && objectId(ticket.metadata.clientUserId) !== objectId(clientId))
    ) {
        throw failure('تعذر تحديد صاحب طلب الإيداع.', 409);
    }
    const client = await User.findOne({
        _id: clientId,
        ...(tx.tenantId ? { tenantId: tx.tenantId } : {}),
    }).session(session);
    if (!client) throw failure('تعذر العثور على حساب العميل.', 404);

    if (approved) {
        const balanceResult = await updateBalanceWithLedger(
            'User',
            client._id,
            tx.amount,
            'DEPOSIT',
            tx.customId,
            `إيداع معتمد ${tx.customId}`,
            { session, tenantId: client.tenantId }
        );
        tx.status = 'deposit';
        tx.balanceAdjustment = {
            entityModel: 'User',
            entityId: client._id,
            delta: tx.amount,
            reversible: true,
        };
        tx.depositRequest.reviewedById = reviewerId;
        tx.depositRequest.reviewedByName = reviewerName;
        tx.depositRequest.reviewedAt = reviewedAt;
        tx.performedByAdminId = reviewerId;
        tx.performedByAdminName = reviewerName;
        tx.performedByAdminAt = reviewedAt;
        await tx.save({ session });
        client.balance = balanceResult.balanceAfter;
    } else {
        tx.status = 'rejected';
        tx.depositRequest.reviewedById = reviewerId;
        tx.depositRequest.reviewedByName = reviewerName;
        tx.depositRequest.reviewedAt = reviewedAt;
        tx.depositRequest.rejectionReason = cleanReason;
        await tx.save({ session });
    }

    ticket.status = approved ? 'resolved' : 'closed';
    ticket.resolvedAt = approved ? reviewedAt : ticket.resolvedAt;
    ticket.closedAt = approved ? ticket.closedAt : reviewedAt;
    ticket.unreadUser = Number(ticket.unreadUser || 0) + 1;
    ticket.metadata.depositRequest.status = approved ? 'approved' : 'rejected';
    ticket.metadata.depositRequest.reviewedById = reviewerId;
    ticket.metadata.depositRequest.reviewedByName = reviewerName;
    ticket.metadata.depositRequest.reviewedAt = reviewedAt;
    if (!approved) ticket.metadata.depositRequest.rejectionReason = cleanReason;
    ticket.messages.push({
        sender: 'admin',
        senderName: reviewerName,
        text: approved
            ? `تم قبول طلب الإيداع وإضافة ${tx.amount} LYD إلى رصيدك.`
            : `تم رفض طلب الإيداع. السبب: ${cleanReason}`,
        channel: 'portal',
        direction: 'outbound',
        messageType: 'text',
        createdAt: reviewedAt,
    });
    ticket.markModified('metadata');
    await ticket.save({ session });

    return { transaction: tx, ticket, client };
}

async function resolveClientDepositTicket(request) {
    const result = await runDepositTransaction((session) =>
        resolveClientDepositTicketInSession({ ...request, session })
    );
    const { transaction: tx, client } = result;
    if (request.approved) {
        await notifyBalanceAdjustment({
            accountModel: 'User',
            account: client,
            amount: tx.amount,
            balanceAfter: client.balance,
            customId: tx.customId,
            notes: tx.depositRequest?.note || '',
        }).catch(() => null);
    } else {
        await createClientNotifications({
            accountModel: 'User',
            account: client,
            title: 'تم رفض طلب الإيداع',
            message: `تم رفض طلب الإيداع ${tx.customId}. السبب: ${tx.depositRequest.rejectionReason}`,
            type: 'deposit_pending',
            txId: tx.customId,
        }).catch(() => null);
    }
    return { transaction: tx, ticket: result.ticket };
}

module.exports = {
    createClientDepositRequest,
    listClientDepositRequests,
    resolveClientDepositTicket,
};
