const express = require('express');
const router = express.Router();

const SupportTicket = require('../models/SupportTicket');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { sendWhatChimpText, normalizeWhatsAppPhone } = require('../services/whatsappService');
const {
    hasActiveWhatsAppWindow,
    isWhatsAppSupportTicket
} = require('../services/whatChimpSupportService');
const { createSupportReplyNotifications } = require('../services/clientNotificationService');
const { resolveDepositTicket } = require('../services/executorDepositRequestService');
const { resolveClientDepositTicket } = require('../services/clientDepositRequestService');
const { recordWhatsAppDeliveryAttempt } = require('../services/whatsappReceiptDeliveryService');
const {
    SUPPORT_STATUSES,
    SUPPORT_PRIORITIES,
    SUPPORT_CATEGORIES,
    getAdminIdentity,
    listSupportTickets,
    getSupportSummary,
    listSupportAgents,
    getSupportTicketWorkspace,
    acquireTicketPresence,
    heartbeatTicketPresence,
    releaseTicketPresence,
    assertTicketWritableByAdmin
} = require('../services/supportWorkspaceService');

const emitTicketUpdate = (req, ticket) => {
    req.app.get('io')?.emit('support:ticket-updated', {
        ticketId: String(ticket._id),
        channel: ticket.channel || 'portal',
        status: ticket.status
    });
};

const WHATSAPP_TEST_MESSAGE = 'رسالة اختبار من منظومة Power Pay AL-Ahram. الرجاء الرد بكلمة اختبار لتأكيد ظهور الرسالة في مركز الدعم.';

router.get('/support', requireAuth, async (req, res) => {
    try {
        res.render('support_admin', {
            adminName: req.session.adminName,
            supportAdmin: getAdminIdentity(req)
        });
    } catch (e) {
        res.redirect('/');
    }
});

router.get('/api/support/tickets', requireAuth, async (req, res) => {
    try {
        const result = await listSupportTickets({ query: req.query, adminIdentity: getAdminIdentity(req) });
        return res.json({ success: true, ...result });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل قائمة تذاكر الدعم.' });
    }
});

router.get('/api/support/summary', requireAuth, async (_req, res) => {
    try {
        return res.json({ success: true, summary: await getSupportSummary() });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل ملخص الدعم.' });
    }
});

router.get('/api/support/agents', requireAuth, async (req, res) => {
    try {
        return res.json({ success: true, agents: await listSupportAgents(getAdminIdentity(req)) });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل قائمة موظفي الدعم.' });
    }
});

router.post('/api/support/tickets/:id/presence', requireAuth, async (req, res) => {
    try {
        const action = String(req.body?.action || 'acquire').trim();
        const adminIdentity = getAdminIdentity(req);
        let presence;

        if (action === 'release') presence = await releaseTicketPresence(req.params.id, adminIdentity);
        else if (action === 'heartbeat') presence = await heartbeatTicketPresence(req.params.id, adminIdentity);
        else presence = await acquireTicketPresence(req.params.id, adminIdentity);

        if (!presence) return res.status(404).json({ success: false, error: 'التذكرة غير موجودة.' });
        return res.status(presence.acquired === false && action !== 'release' ? 409 : 200).json({ success: true, presence });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'تعذر تحديث حالة معالجة التذكرة.' });
    }
});

router.patch('/api/support/tickets/:id/state', requireAuth, async (req, res) => {
    try {
        const adminIdentity = getAdminIdentity(req);
        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ success: false, error: 'التذكرة غير موجودة.' });
        assertTicketWritableByAdmin(ticket, adminIdentity);

        if (req.body?.status !== undefined) {
            const status = String(req.body.status || '').trim();
            if (!SUPPORT_STATUSES.includes(status)) {
                return res.status(422).json({ success: false, error: 'حالة التذكرة غير صالحة.' });
            }
            ticket.status = status;
            if (status === 'resolved') ticket.resolvedAt = new Date();
            if (status === 'closed') ticket.closedAt = new Date();
            if (status === 'open') {
                ticket.resolvedAt = undefined;
                ticket.closedAt = undefined;
            }
        }

        if (req.body?.priority !== undefined) {
            const priority = String(req.body.priority || '').trim();
            if (!SUPPORT_PRIORITIES.includes(priority)) {
                return res.status(422).json({ success: false, error: 'أولوية التذكرة غير صالحة.' });
            }
            ticket.priority = priority;
        }

        if (req.body?.category !== undefined) {
            const category = String(req.body.category || '').trim();
            if (!SUPPORT_CATEGORIES.includes(category)) {
                return res.status(422).json({ success: false, error: 'تصنيف التذكرة غير صالح.' });
            }
            ticket.category = category;
        }

        if (req.body?.assigneeId !== undefined) {
            const assigneeId = String(req.body.assigneeId || '').trim();
            if (!assigneeId) {
                ticket.assignedToId = undefined;
                ticket.assignedToName = undefined;
                ticket.assignedAt = undefined;
            } else {
                const agents = await listSupportAgents(adminIdentity);
                const assignee = agents.find((agent) => agent.id === assigneeId);
                if (!assignee) return res.status(422).json({ success: false, error: 'موظف الدعم المحدد غير موجود.' });
                ticket.assignedToId = assignee.id;
                ticket.assignedToName = assignee.name;
                ticket.assignedAt = new Date();
            }
        }

        if (Array.isArray(req.body?.tags)) {
            ticket.tags = [...new Set(req.body.tags
                .map((tag) => String(tag || '').replace(/\s+/g, ' ').trim().slice(0, 30))
                .filter(Boolean))]
                .slice(0, 8);
        }

        await ticket.save();
        emitTicketUpdate(req, ticket);
        return res.json({ success: true, ticket });
    } catch (error) {
        return res.status(error.status || 500).json({
            success: false,
            code: error.code || '',
            error: error.status ? error.message : 'تعذر تحديث التذكرة.'
        });
    }
});

router.get('/api/support/tickets/:id', requireAuth, async (req, res) => {
    try {
        const workspace = await getSupportTicketWorkspace(req.params.id, getAdminIdentity(req));
        if (!workspace) return res.status(404).json({ success: false, error: 'التذكرة غير موجودة' });
        await SupportTicket.updateOne({ _id: req.params.id }, { $set: { unreadAdmin: 0 } }, { timestamps: false });
        workspace.ticket.unreadAdmin = 0;
        workspace.summary.unreadAdmin = 0;
        return res.json({ success: true, ...workspace });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'تعذر تحميل تفاصيل التذكرة.' });
    }
});

router.post('/api/support/tickets/:id/reply', requireAuth, async (req, res) => {
    try {
        const text = String(req.body?.text || '').trim().slice(0, 4096);
        if (!text) return res.status(400).json({ success: false, error: 'نص الرد مطلوب.' });

        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ success: false, error: 'التذكرة غير موجودة' });
        if (ticket.status === 'closed') return res.status(409).json({ success: false, error: 'لا يمكن الرد على تذكرة مغلقة.' });
        const adminIdentity = getAdminIdentity(req);
        assertTicketWritableByAdmin(ticket, adminIdentity);

        if (!ticket.assignedToId) {
            ticket.assignedToId = adminIdentity.id;
            ticket.assignedToName = adminIdentity.name;
            ticket.assignedAt = new Date();
        }

        let delivery = null;
        let channel = 'portal';
        const whatsapp = {
            eligible: isWhatsAppSupportTicket(ticket),
            attempted: false,
            delivered: false,
            code: ''
        };
        let warning = '';

        if (whatsapp.eligible) {
            if (!hasActiveWhatsAppWindow(ticket)) {
                whatsapp.code = 'WHATSAPP_WINDOW_EXPIRED';
                warning = 'تم حفظ الرد في صفحة الدعم فقط لأن نافذة محادثة واتساب انتهت. يرسل العميل رسالة جديدة عبر واتساب لاستئناف الرد المباشر.';
                await recordWhatsAppDeliveryAttempt({
                    kind: 'support',
                    recipientPhone: ticket.phoneNormalized || ticket.phone,
                    recipientName: ticket.name,
                    recipientModel: 'SupportTicket',
                    recipientId: ticket._id,
                    reference: ticket.ticketId || String(ticket._id),
                    skipped: true,
                    result: { code: whatsapp.code, message: 'انتهت نافذة محادثة WhatsApp لمدة 24 ساعة؛ لم يتم إرسال النص الحر.' },
                    metadata: { ticketId: String(ticket._id), channel: 'support_reply' }
                });
            } else if (!ticket.phoneNormalized && !ticket.phone) {
                whatsapp.code = 'WHATSAPP_PHONE_MISSING';
                warning = 'تم حفظ الرد في صفحة الدعم فقط لأن رقم واتساب غير متاح لهذه المحادثة.';
                await recordWhatsAppDeliveryAttempt({
                    kind: 'support',
                    recipientName: ticket.name,
                    recipientModel: 'SupportTicket',
                    recipientId: ticket._id,
                    reference: ticket.ticketId || String(ticket._id),
                    skipped: true,
                    result: { code: whatsapp.code, message: 'رقم واتساب غير متاح لهذه المحادثة.' },
                    metadata: { ticketId: String(ticket._id), channel: 'support_reply' }
                });
            } else {
                whatsapp.attempted = true;
                try {
                    delivery = await sendWhatChimpText({
                        phone: ticket.phoneNormalized || ticket.phone,
                        message: text
                    });
                } catch (_error) {
                    delivery = { success: false, code: 'WHATCHIMP_REQUEST_FAILED' };
                }

                if (delivery?.success) {
                    channel = 'whatsapp';
                    whatsapp.delivered = true;
                } else {
                    whatsapp.code = delivery?.code || 'WHATCHIMP_REQUEST_FAILED';
                    warning = 'تم حفظ الرد في صفحة الدعم فقط، وتعذر تسليمه عبر واتساب حالياً.';
                }
                await recordWhatsAppDeliveryAttempt({
                    kind: 'support',
                    recipientPhone: ticket.phoneNormalized || ticket.phone,
                    recipientName: ticket.name,
                    recipientModel: 'SupportTicket',
                    recipientId: ticket._id,
                    reference: ticket.ticketId || String(ticket._id),
                    result: delivery || { success: false, code: 'WHATCHIMP_REQUEST_FAILED' },
                    metadata: { ticketId: String(ticket._id), channel: 'support_reply' }
                });
            }
        }

        const newMessage = {
            sender: 'admin',
            senderName: req.session.adminName || 'الإدارة',
            text,
            channel,
            direction: 'outbound',
            providerMessageId: delivery?.messageId || '',
            deliveryStatus: whatsapp.delivered ? 'sent' : (whatsapp.eligible ? 'portal_only' : ''),
            createdAt: new Date()
        };
        ticket.messages.push(newMessage);
        ticket.status = 'answered';
        ticket.firstResponseAt = ticket.firstResponseAt || newMessage.createdAt;
        ticket.unreadUser = (ticket.unreadUser || 0) + 1;
        ticket.activeHandlerId = adminIdentity.id;
        ticket.activeHandlerName = adminIdentity.name;
        ticket.activeHandlerExpiresAt = new Date(Date.now() + 60 * 1000);
        if (channel === 'whatsapp') ticket.lastWhatsAppOutboundAt = newMessage.createdAt;
        await ticket.save();
        emitTicketUpdate(req, ticket);

        try { await createSupportReplyNotifications({ ticket, channel }); } catch (_error) {}
        
        res.json({ success: true, message: newMessage, channel, whatsapp, warning });
    } catch (error) {
        res.status(error.status || 500).json({
            success: false,
            code: error.code || '',
            error: error.status ? error.message : 'تعذر إرسال الرد.'
        });
    }
});

// This creates an auditable support ticket without pretending that the recipient opened a 24-hour WhatsApp window.
router.post('/api/support/whatsapp-test', requireAuth, async (req, res) => {
    try {
        const suppliedPhone = String(req.body?.phone || '').trim();
        let phoneNormalized;
        try {
            phoneNormalized = normalizeWhatsAppPhone(suppliedPhone);
        } catch (error) {
            return res.status(422).json({
                success: false,
                code: error.code || 'WHATSAPP_PHONE_INVALID',
                error: error.message || 'رقم واتساب غير صالح.'
            });
        }

        const existingTicketQuery = SupportTicket.findOne({
            'metadata.type': 'whatsapp_test',
            phoneNormalized,
            status: { $ne: 'closed' }
        });
        let ticket = await existingTicketQuery.sort({ updatedAt: -1 });

        if (!ticket) {
            ticket = new SupportTicket({
                entityType: 'whatsapp',
                name: `اختبار واتساب ${phoneNormalized}`,
                phone: suppliedPhone,
                phoneNormalized,
                channel: 'whatsapp',
                status: 'open',
                messages: [],
                metadata: {
                    type: 'whatsapp_test',
                    replyChannel: 'whatsapp',
                    whatsapp: {
                        phoneNormalized,
                        testTicket: true
                    }
                }
            });
        }

        let delivery;
        try {
            delivery = await sendWhatChimpText({ phone: phoneNormalized, message: WHATSAPP_TEST_MESSAGE });
        } catch (_error) {
            delivery = { success: false, code: 'WHATCHIMP_REQUEST_FAILED' };
        }

        const sentAt = new Date();
        const delivered = Boolean(delivery?.success);
        await recordWhatsAppDeliveryAttempt({
            kind: 'test',
            recipientPhone: phoneNormalized,
            recipientName: ticket.name,
            recipientModel: 'SupportTicket',
            recipientId: ticket._id,
            reference: ticket.ticketId || String(ticket._id),
            result: delivery || { success: false, code: 'WHATCHIMP_REQUEST_FAILED' },
            metadata: { ticketId: String(ticket._id), channel: 'support_test' }
        });
        const testMessage = {
            sender: 'admin',
            senderName: 'اختبار المنظومة',
            text: WHATSAPP_TEST_MESSAGE,
            channel: 'whatsapp',
            direction: 'outbound',
            providerMessageId: delivery?.messageId || '',
            deliveryStatus: delivered ? 'sent' : 'failed',
            createdAt: sentAt
        };

        ticket.messages.push(testMessage);
        if (delivered) {
            ticket.status = 'answered';
            ticket.unreadUser = (ticket.unreadUser || 0) + 1;
            ticket.lastWhatsAppOutboundAt = sentAt;
        }
        await ticket.save();
        emitTicketUpdate(req, ticket);

        if (delivered) {
            try { await createSupportReplyNotifications({ ticket, channel: 'whatsapp' }); } catch (_error) {}
        }

        const response = {
            success: delivered,
            ticketId: String(ticket._id),
            ticket,
            message: testMessage,
            whatsapp: {
                attempted: true,
                delivered,
                code: delivery?.code || (delivered ? 'WHATCHIMP_SENT' : 'WHATCHIMP_REQUEST_FAILED'),
                messageId: delivery?.messageId || ''
            }
        };

        if (!delivered) {
            return res.status(422).json({
                ...response,
                error: delivery?.message || 'تعذر إرسال رسالة الاختبار عبر واتساب. راجع سبب الرفض في WhatChimp.'
            });
        }

        return res.json(response);
    } catch (error) {
        return res.status(500).json({ success: false, error: 'تعذر إنشاء تذكرة اختبار واتساب.' });
    }
});

router.post('/api/support/tickets/:id/whatsapp-test', requireAuth, async (req, res) => {
    try {
        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ success: false, error: 'التذكرة غير موجودة.' });
        if (ticket.status === 'closed') return res.status(409).json({ success: false, error: 'لا يمكن اختبار تذكرة مغلقة.' });
        if (!isWhatsAppSupportTicket(ticket)) {
            return res.status(409).json({
                success: false,
                code: 'WHATSAPP_TICKET_REQUIRED',
                error: 'زر الاختبار متاح بعد أن يبدأ العميل محادثة عبر واتساب.'
            });
        }
        if (!hasActiveWhatsAppWindow(ticket)) {
            return res.status(409).json({
                success: false,
                code: 'WHATSAPP_WINDOW_EXPIRED',
                error: 'انتهت نافذة محادثة واتساب. يرسل العميل رسالة جديدة عبر واتساب قبل الاختبار.'
            });
        }

        const phone = ticket.phoneNormalized || ticket.phone;
        if (!phone) {
            return res.status(422).json({
                success: false,
                code: 'WHATSAPP_PHONE_MISSING',
                error: 'رقم واتساب غير متاح لهذه التذكرة.'
            });
        }

        const testText = 'رسالة اختبار من منظومة Power Pay AL-Ahram. إذا وصلتك هذه الرسالة، فإن ربط الدعم عبر واتساب يعمل بنجاح.';
        let delivery;
        try {
            delivery = await sendWhatChimpText({ phone, message: testText });
        } catch (_error) {
            delivery = { success: false, code: 'WHATCHIMP_REQUEST_FAILED' };
        }

        if (!delivery?.success) {
            await recordWhatsAppDeliveryAttempt({
                kind: 'test',
                recipientPhone: phone,
                recipientName: ticket.name,
                recipientModel: 'SupportTicket',
                recipientId: ticket._id,
                reference: ticket.ticketId || String(ticket._id),
                result: delivery || { success: false, code: 'WHATCHIMP_REQUEST_FAILED' },
                metadata: { ticketId: String(ticket._id), channel: 'ticket_test' }
            });
            return res.status(422).json({
                success: false,
                code: delivery?.code || 'WHATCHIMP_REQUEST_FAILED',
                error: delivery?.message || 'تعذر إرسال رسالة اختبار واتساب.'
            });
        }

        const newMessage = {
            sender: 'admin',
            senderName: 'اختبار المنظومة',
            text: testText,
            channel: 'whatsapp',
            direction: 'outbound',
            providerMessageId: delivery.messageId || '',
            deliveryStatus: 'sent',
            createdAt: new Date()
        };
        await recordWhatsAppDeliveryAttempt({
            kind: 'test',
            recipientPhone: phone,
            recipientName: ticket.name,
            recipientModel: 'SupportTicket',
            recipientId: ticket._id,
            reference: ticket.ticketId || String(ticket._id),
            result: delivery,
            metadata: { ticketId: String(ticket._id), channel: 'ticket_test' }
        });
        ticket.messages.push(newMessage);
        ticket.status = 'answered';
        ticket.unreadUser = (ticket.unreadUser || 0) + 1;
        ticket.lastWhatsAppOutboundAt = newMessage.createdAt;
        await ticket.save();
        emitTicketUpdate(req, ticket);
        try { await createSupportReplyNotifications({ ticket, channel: 'whatsapp' }); } catch (_error) {}

        return res.json({
            success: true,
            message: newMessage,
            whatsapp: {
                eligible: true,
                attempted: true,
                delivered: true,
                code: delivery.code || 'WHATCHIMP_SENT',
                messageId: delivery.messageId || ''
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'تعذر تنفيذ اختبار واتساب.' });
    }
});

router.post('/api/support/tickets/:id/close', requireAuth, async (req, res) => {
    try {
        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ success: false, error: 'التذكرة غير موجودة' });
        assertTicketWritableByAdmin(ticket, getAdminIdentity(req));
        ticket.status = 'closed';
        ticket.closedAt = new Date();
        ticket.activeHandlerId = undefined;
        ticket.activeHandlerName = undefined;
        ticket.activeHandlerExpiresAt = undefined;
        await ticket.save();
        emitTicketUpdate(req, ticket);
        res.json({ success: true });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, code: error.code || '', error: error.message });
    }
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
        ticket.closedAt = new Date();
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
        ticket.closedAt = new Date();
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

// Financial approval is intentionally limited to the master administrator.
// The transaction update is atomic, so two support agents cannot credit it twice.
router.post('/api/support/tickets/:id/executor-deposit/:decision', requireAuth, requireMaster, async (req, res) => {
    try {
        const decision = String(req.params.decision || '');
        if (!['approve', 'reject'].includes(decision)) return res.status(422).json({ success: false, error: 'قرار المراجعة غير صالح.' });
        const ticket = await SupportTicket.findById(req.params.id).select('metadata messages.sender').lean();
        if (ticket?.metadata?.depositRequest?.submittedByRole === 'admin' || ticket?.messages?.[0]?.sender === 'admin') {
            return res.status(403).json({ success: false, error: 'هذا طلب إيداع صادر من الإدارة ويجب أن تراجعه شركة التنفيذ من حسابها.' });
        }
        const result = await resolveDepositTicket({
            ticketId: req.params.id,
            admin: getAdminIdentity(req),
            approved: decision === 'approve',
            reason: req.body?.reason
        });
        emitTicketUpdate(req, result.ticket);
        return res.json({ success: true, status: decision === 'approve' ? 'approved' : 'rejected' });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر مراجعة طلب الإيداع.' });
    }
});

router.post('/api/support/tickets/:id/client-deposit/:decision', requireAuth, requireMaster, async (req, res) => {
    try {
        const decision = String(req.params.decision || '');
        if (!['approve', 'reject'].includes(decision)) {
            return res.status(422).json({ success: false, error: 'قرار المراجعة غير صالح.' });
        }
        const result = await resolveClientDepositTicket({
            ticketId: req.params.id,
            admin: getAdminIdentity(req),
            approved: decision === 'approve',
            reason: req.body?.reason
        });
        emitTicketUpdate(req, result.ticket);
        return res.json({ success: true, status: decision === 'approve' ? 'approved' : 'rejected' });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر مراجعة طلب إيداع العميل.' });
    }
});

module.exports = router;
