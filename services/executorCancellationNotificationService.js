'use strict';

const Admin = require('../models/Admin');
const { attachCancellationReceipt } = require('./cancellationReceiptService');
const { appendAdminNote } = require('../utils/executorTransactionNotes');
const { logExecutorFailure } = require('./executorTransactionError');

const notifyAdmins = async (msgText) => {
    try {
        const Notification = require('../models/Notification');
        const admins = await Admin.find({});
        for (const admin of admins) {
            await Notification.create({
                userId: admin.webUsername || 'admin',
                title: 'تنبيه إداري',
                message: msgText.replace(/<[^>]*>?/gm, ''),
                type: 'system_alert'
            }).catch((error) => logExecutorFailure('cancellation-admin-notification', error));
        }
    } catch (error) {
        logExecutorFailure('cancellation-admin-notification', error);
    }
};

const notifyExecutorCancellation = async ({ tx, emp, reason, cancelledAt }) => {
    let cancellationReceiptReady = false;
    try {
        cancellationReceiptReady = Boolean(await attachCancellationReceipt(tx, {
            reason,
            performedBy: emp.name || 'المنفذ',
            cancelledAt
        }));
    } catch (receiptError) {
        logExecutorFailure('cancellation-receipt', receiptError);
        appendAdminNote(tx, '[تعذر توليد إيصال الإلغاء]');
        await tx.save().catch((error) => logExecutorFailure('cancellation-receipt-note', error));
    }

    if (cancellationReceiptReady) {
        try {
            const { sendCancelledTransactionReceipt } = require('./whatsappReceiptDeliveryService');
            await sendCancelledTransactionReceipt(tx);
        } catch (whatsappError) {
            logExecutorFailure('cancellation-whatsapp', whatsappError);
        }
    }

    const adminMsg = [
        '🚨 <b>تنبيه للإدارة: تم إلغاء عملية من قِبل المنفذ!</b>',
        '',
        `🏢 <b>الجهة/العميل:</b> ${tx.companyName || 'عميل فردي'}`,
        `👤 <b>الموظف الطالب:</b> ${tx.employeeName || 'غير محدد'}`,
        `🤖 <b>بواسطة المنفذ:</b> ${emp.name}`,
        '',
        `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>`,
        `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>`,
        `💵 <b>المبلغ:</b> ${tx.amount} EGP`,
        `🇱🇾 <b>التكلفة المسترجعة:</b> ${tx.costLYD.toFixed(2)} LYD`,
        `⚠️ <b>سبب الإلغاء:</b> <b>${reason}</b>`
    ].join('\n');
    notifyAdmins(adminMsg);
};

module.exports = { notifyExecutorCancellation };
