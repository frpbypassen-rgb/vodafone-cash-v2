const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');

const SupportTicket = require('../models/SupportTicket');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { sendWhatChimpText } = require('../services/whatsappService');

const emitTicketUpdate = (req, ticket) => {
    req.app.get('io')?.emit('support:ticket-updated', {
        ticketId: String(ticket._id),
        channel: ticket.channel || 'portal',
        status: ticket.status
    });
};

const isWhatsAppTicket = (ticket) => (
    ticket.channel === 'whatsapp' || ticket.metadata?.replyChannel === 'whatsapp'
);

router.get('/support', requireAuth, async (req, res) => {
    try { res.render('support_admin', { adminName: req.session.adminName }); } catch (e) { res.redirect('/'); }
});

router.get('/api/support/tickets', requireAuth, async (req, res) => {
    try { const tickets = await SupportTicket.find({}).sort({ updatedAt: -1 }); res.json({ success: true, tickets }); } catch (e) { res.json({ success: false, error: e.message }); }
});

router.get('/api/support/tickets/:id', requireAuth, async (req, res) => {
    try { const ticket = await SupportTicket.findById(req.params.id); if (!ticket) return res.json({ success: false, error: 'التذكرة غير موجودة' }); ticket.unreadAdmin = 0; await ticket.save(); res.json({ success: true, ticket }); } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/support/tickets/:id/reply', requireAuth, async (req, res) => {
    try {
        const text = String(req.body?.text || '').trim().slice(0, 4096);
        if (!text) return res.status(400).json({ success: false, error: 'نص الرد مطلوب.' });

        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ success: false, error: 'التذكرة غير موجودة' });
        if (ticket.status === 'closed') return res.status(409).json({ success: false, error: 'لا يمكن الرد على تذكرة مغلقة.' });

        let delivery = null;
        let channel = 'portal';
        if (isWhatsAppTicket(ticket)) {
            const expiresAt = ticket.whatsappWindowExpiresAt ? new Date(ticket.whatsappWindowExpiresAt) : null;
            if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
                return res.status(422).json({
                    success: false,
                    error: 'انتهت نافذة محادثة واتساب. يجب أن يرسل العميل رسالة جديدة قبل إرسال رد نصي.'
                });
            }

            delivery = await sendWhatChimpText({
                phone: ticket.phoneNormalized || ticket.phone,
                message: text
            });
            if (!delivery.success) {
                return res.status(422).json({
                    success: false,
                    code: delivery.code || 'WHATCHIMP_REQUEST_FAILED',
                    error: delivery.message || 'تعذر إرسال رد واتساب.'
                });
            }
            channel = 'whatsapp';
        }

        const newMessage = {
            sender: 'admin',
            senderName: req.session.adminName || 'الإدارة',
            text,
            channel,
            direction: 'outbound',
            providerMessageId: delivery?.messageId || '',
            deliveryStatus: delivery ? 'sent' : '',
            createdAt: new Date()
        };
        ticket.messages.push(newMessage);
        ticket.status = 'answered';
        ticket.unreadUser = (ticket.unreadUser || 0) + 1;
        if (channel === 'whatsapp') ticket.lastWhatsAppOutboundAt = newMessage.createdAt;
        await ticket.save();
        emitTicketUpdate(req, ticket);

        if (channel === 'portal') {
            try {
                await Notification.create({
                    userId: ticket.userPhone || ticket.webUsername,
                    title: 'رد من الدعم الفني',
                    message: `لديك رد جديد على التذكرة.`,
                    type: 'system_alert'
                });
            } catch(e) {}
        }
        
        res.json({ success: true, message: newMessage, channel });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/support/tickets/:id/close', requireAuth, async (req, res) => {
    try {
        const ticket = await SupportTicket.findById(req.params.id); if (!ticket) return res.json({ success: false, error: 'التذكرة غير موجودة' });
        ticket.status = 'closed'; await ticket.save();
        emitTicketUpdate(req, ticket);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/support/tickets/:id/password-reset/approve', requireAuth, requireMaster, async (req, res) => {
    try {
        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.json({ success: false, error: 'التذكرة غير موجودة' });

        const requestId = ticket.metadata && ticket.metadata.passwordResetRequestId;
        const resetRequest = requestId
            ? await PasswordResetRequest.findById(requestId)
            : await PasswordResetRequest.findOne({ ticketId: ticket._id });

        if (!resetRequest || resetRequest.status !== 'pending_admin') {
            return res.json({ success: false, error: 'طلب استعادة كلمة المرور غير صالح أو تمت مراجعته مسبقاً.' });
        }

        const Model = resetRequest.accountModel === 'SubAccount' ? SubAccount : User;
        await Model.updateOne(
            { _id: resetRequest.accountId },
            {
                $set: {
                    webPassword: resetRequest.pendingPasswordHash,
                    status: 'active'
                },
                $unset: {
                    refreshToken: 1,
                    otpCode: 1,
                    otpExpires: 1
                }
            },
            { strict: false }
        );

        resetRequest.status = 'approved';
        resetRequest.reviewedBy = req.session.adminName || 'الإدارة';
        resetRequest.reviewedAt = new Date();
        await resetRequest.save();
        await PasswordResetRequest.updateOne(
            { _id: resetRequest._id },
            { $unset: { pendingPasswordPlain: 1, pendingPasswordHash: 1 } },
            { strict: false }
        );

        ticket.status = 'closed';
        ticket.metadata = {
            ...(ticket.metadata || {}),
            passwordResetStatus: 'approved'
        };
        ticket.messages.push({
            sender: 'admin',
            senderName: req.session.adminName || 'الإدارة',
            text: 'تم تأكيد كلمة المرور الجديدة وتفعيل الحساب. تم إغلاق الطلب.',
            createdAt: new Date()
        });
        await ticket.save();

        return res.json({ success: true });
    } catch (e) {
        return res.json({ success: false, error: e.message });
    }
});

router.post('/api/support/tickets/:id/password-reset/reject', requireAuth, requireMaster, async (req, res) => {
    try {
        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.json({ success: false, error: 'التذكرة غير موجودة' });

        const requestId = ticket.metadata && ticket.metadata.passwordResetRequestId;
        const resetRequest = requestId
            ? await PasswordResetRequest.findById(requestId)
            : await PasswordResetRequest.findOne({ ticketId: ticket._id });

        if (!resetRequest || resetRequest.status !== 'pending_admin') {
            return res.json({ success: false, error: 'طلب استعادة كلمة المرور غير صالح أو تمت مراجعته مسبقاً.' });
        }

        resetRequest.status = 'rejected';
        resetRequest.reviewedBy = req.session.adminName || 'الإدارة';
        resetRequest.reviewedAt = new Date();
        await resetRequest.save();
        await PasswordResetRequest.updateOne(
            { _id: resetRequest._id },
            { $unset: { pendingPasswordPlain: 1, pendingPasswordHash: 1 } },
            { strict: false }
        );

        ticket.status = 'closed';
        ticket.metadata = {
            ...(ticket.metadata || {}),
            passwordResetStatus: 'rejected'
        };
        ticket.messages.push({
            sender: 'admin',
            senderName: req.session.adminName || 'الإدارة',
            text: 'تم إلغاء طلب استعادة كلمة المرور. كلمة المرور القديمة ما زالت كما هي.',
            createdAt: new Date()
        });
        await ticket.save();

        return res.json({ success: true });
    } catch (e) {
        return res.json({ success: false, error: e.message });
    }
});

module.exports = router;
