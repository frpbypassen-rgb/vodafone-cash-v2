'use strict';
const {
    supportMessageDto,
    getSupportIdentity,
    parseSupportImage,
} = require('../../services/portalSupportService');

const express = require('express');

const router = express.Router();

const { emitSupportTicketUpdate } = require('../../services/supportRealtimeService');

const crypto = require('crypto');

const fs = require('fs');

const path = require('path');

const SupportTicket = require('../../models/SupportTicket');

const { setPortalSupportReplyChannel } = require('../../services/whatChimpSupportService');

const { requireClientAuth } = require('../../middlewares/clientPortalAuth');

const businessPortalService = require('../../services/businessPortalService');

router.get('/api/support/messages', requireClientAuth, async (req, res) => {
    try {
        const { account, entityType } = await getSupportIdentity(req);
        if (!account) return res.status(401).json({ success: false, error: 'Unauthorized' });

        let ticket = await SupportTicket.findOne({
            entityType,
            entityId: account._id,
            status: { $ne: 'closed' },
        }).sort({ createdAt: -1 });
        if (!ticket) {
            ticket = new SupportTicket({
                entityType,
                entityId: account._id,
                telegramId: account.phone || account.webUsername,
                name: account.name || 'مستخدم البوابة',
                phone: account.phone || 'غير مسجل',
                messages: [],
            });
            await ticket.save();
        }
        if (ticket.unreadUser > 0) {
            ticket.unreadUser = 0;
            await ticket.save();
        }
        res.json({
            success: true,
            messages: ticket.messages.map((message, index) =>
                supportMessageDto(ticket, message, index, req.baseUrl || '/client')
            ),
        });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

router.get('/api/support/tickets/:ticketId/images/:index', requireClientAuth, async (req, res) => {
    try {
        const index = Number.parseInt(req.params.index, 10);
        if (!Number.isInteger(index) || index < 0 || !/^[a-f\d]{24}$/i.test(req.params.ticketId)) {
            return res.status(404).send('المرفق غير موجود.');
        }
        const { account, entityType } = await getSupportIdentity(req);
        const ticket = await SupportTicket.findOne({
            _id: req.params.ticketId,
            entityType,
            entityId: account?._id,
        })
            .select('messages.imageUrl')
            .lean();
        const sourceUrl = String(ticket?.messages?.[index]?.imageUrl || '');
        const fileName = path.basename(sourceUrl);
        if (!/^support_[a-f\d-]+\.(?:jpg|jpeg|png|webp)$/i.test(fileName)) {
            return res.status(404).send('المرفق غير موجود.');
        }
        const uploadRoot = path.resolve(__dirname, '../uploads');
        const filePath = path.resolve(uploadRoot, fileName);
        if (!filePath.startsWith(`${uploadRoot}${path.sep}`) || !fs.existsSync(filePath)) {
            return res.status(404).send('المرفق غير موجود.');
        }
        return res.sendFile(filePath, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
    } catch (_error) {
        return res.status(404).send('المرفق غير موجود.');
    }
});

router.post('/api/support/messages', requireClientAuth, async (req, res) => {
    let storedImagePath = null;
    try {
        const text = String(req.body.text || '')
            .trim()
            .slice(0, 1000);
        const parsedImage = parseSupportImage(req.body.imageBase64);
        if (!text && !parsedImage) {
            return res.status(400).json({ success: false, error: 'اكتب رسالة أو أرفق صورة.' });
        }

        const { account, entityType } = await getSupportIdentity(req);
        if (!account) return res.status(401).json({ success: false, error: 'Unauthorized' });

        const companyDepositRequest = businessPortalService.isCompanyDepositCreateIntent(text);
        if (companyDepositRequest) {
            const workspace = await businessPortalService.resolveWorkspace(req);
            if (!businessPortalService.canCreateCompanyDepositRequest(workspace)) {
                return res.status(403).json({
                    success: false,
                    error: 'إنشاء طلب الإيداع متاح لمدير التشغيل فقط. يمكنك متابعة الطلبات من صفحة الإيداع.',
                });
            }
        }

        let ticket = await SupportTicket.findOne({
            entityType,
            entityId: account._id,
            status: { $ne: 'closed' },
        });
        if (!ticket) {
            ticket = new SupportTicket({
                entityType,
                entityId: account._id,
                telegramId: account.phone || account.webUsername,
                name: account.name || 'مستخدم البوابة',
                phone: account.phone || 'غير مسجل',
                messages: [],
            });
        }

        let imageUrl = null;
        if (parsedImage) {
            const fileName = `support_${crypto.randomUUID()}${parsedImage.extension}`;
            storedImagePath = path.join(__dirname, '../uploads/', fileName);
            await fs.promises.writeFile(storedImagePath, parsedImage.buffer);
            imageUrl = `/uploads/${fileName}`;
        }

        const newMessage = {
            sender: 'user',
            senderName: account.name || account.webUsername,
            text,
            imageUrl,
            channel: 'portal',
            direction: 'inbound',
            createdAt: new Date(),
        };
        ticket.messages.push(newMessage);
        if (companyDepositRequest) {
            ticket.category = 'deposit';
            ticket.priority = ticket.priority === 'urgent' ? ticket.priority : 'high';
            const metadata =
                ticket.metadata && typeof ticket.metadata === 'object' ? { ...ticket.metadata } : {};
            if (!metadata.type) metadata.type = 'company_deposit';
            ticket.metadata = metadata;
            if (typeof ticket.markModified === 'function') ticket.markModified('metadata');
        }
        setPortalSupportReplyChannel(ticket);
        ticket.status = 'open';
        ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1;
        ticket.updatedAt = new Date();
        await ticket.save();
        emitSupportTicketUpdate(req, {
            ticketId: String(ticket._id),
            channel: ticket.channel || 'portal',
            direction: 'inbound',
            status: ticket.status,
        });

        return res.json({
            success: true,
            message: supportMessageDto(
                ticket,
                newMessage,
                ticket.messages.length - 1,
                req.baseUrl || '/client'
            ),
        });
    } catch (error) {
        if (storedImagePath) fs.promises.unlink(storedImagePath).catch(() => {});
        const invalidImage = error.message === 'INVALID_SUPPORT_IMAGE';
        return res.status(invalidImage ? 400 : 500).json({
            success: false,
            error: invalidImage ? 'الصورة غير صالحة أو تتجاوز 4MB.' : 'تعذر إرسال الرسالة.',
        });
    }
});

module.exports = router;
