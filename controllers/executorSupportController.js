'use strict';

const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const SupportTicket = require('../models/SupportTicket');
const { logExecutorFailure } = require('../services/executorTransactionError');

exports.getSupport = async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId).populate('groupId');
        res.render('executor/support', { emp });
    } catch (error) {
        logExecutorFailure('support-page', error);
        res.redirect('/executor-portal/dashboard');
    }
};

exports.getSupportMessages = async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId);
        let ticket = await SupportTicket.findOne({ entityType: 'executor', entityId: emp._id }).sort({ createdAt: -1 });
        if (ticket) {
            ticket.unreadUser = 0;
            await ticket.save();
            res.json({ success: true, messages: ticket.messages, status: ticket.status });
        } else {
            res.json({ success: true, messages: [], status: 'closed' });
        }
    } catch (error) {
        logExecutorFailure('support', error);
        res.json({ success: false, error: 'تعذر معالجة طلب الدعم.' });
    }
};

exports.postSupportMessages = async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        if (!text && !imageBase64) return res.json({ success: false, error: 'الرسالة فارغة' });

        const emp = await Employee.findById(req.session.executorId).populate('groupId');
        let ticket = await SupportTicket.findOne({ entityType: 'executor', entityId: emp._id, status: { $ne: 'closed' } });

        if (!ticket) {
            ticket = new SupportTicket({
                entityType: 'executor',
                entityId: emp._id,
                telegramId: emp.phone || emp.webUsername,
                name: emp.name || 'منفذ',
                phone: emp.phone || 'غير مسجل',
                messages: []
            });
        }

        const newMsg = { sender: 'user', text: text || '', imageUrl: imageBase64 || '', createdAt: new Date() };
        ticket.messages.push(newMsg);
        ticket.status = 'open';
        ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1;
        await ticket.save();

        const Notification = require('../models/Notification');
        const admins = await Admin.find({}).catch((error) => {
            logExecutorFailure('support-notification', error);
            return [];
        });
        const notifyMsg = `🚨 <b>رسالة دعم فني جديدة (منفذ)!</b>\n\n👤 من: ${emp.name}\n💬 الرسالة: ${text || 'صورة مرفقة'}\n\nيرجى مراجعة لوحة التحكم للرد.`;

        for (const admin of admins) {
            await Notification.create({
                userId: admin.webUsername || 'admin',
                title: 'رسالة دعم فني جديدة',
                message: notifyMsg.replace(/<[^>]*>?/gm, ''),
                type: 'support_message'
            }).catch((error) => logExecutorFailure('support-notification', error));
        }

        res.json({ success: true, message: newMsg });
    } catch (error) {
        logExecutorFailure('support-message', error);
        res.json({ success: false, error: 'تعذر إرسال رسالة الدعم.' });
    }
};
