'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../models/Notification', () => ({ create: jest.fn() }));
jest.mock('../models/SupportTicket', () => {
    const SupportTicket = jest.fn(function MockSupportTicket(data) {
        Object.assign(this, data);
        this._id = this._id || 'created-whatsapp-test';
        this.save = jest.fn().mockResolvedValue(undefined);
    });
    SupportTicket.findById = jest.fn();
    SupportTicket.find = jest.fn();
    SupportTicket.findOne = jest.fn();
    return SupportTicket;
});
jest.mock('../services/whatsappService', () => ({
    sendWhatChimpText: jest.fn(),
    normalizeWhatsAppPhone: jest.fn((phone) => String(phone).replace(/\D/g, '') === '0940719000' ? '218940719000' : '201108172258')
}));
jest.mock('../services/clientNotificationService', () => ({ createSupportReplyNotifications: jest.fn() }));
jest.mock('../middlewares/auth', () => ({
    requireAuth: (req, _res, next) => {
        req.session = { adminName: 'Admin' };
        next();
    },
    requireMaster: (_req, _res, next) => next()
}));

const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');
const { sendWhatChimpText, normalizeWhatsAppPhone } = require('../services/whatsappService');
const { createSupportReplyNotifications } = require('../services/clientNotificationService');
const supportRouter = require('../routes/support');

const createTicket = (overrides = {}) => ({
    _id: 'ticket-1',
    channel: 'whatsapp',
    metadata: { replyChannel: 'whatsapp' },
    phoneNormalized: '201108172258',
    whatsappWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    messages: [],
    status: 'open',
    unreadUser: 0,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
});

describe('WhatsApp support replies', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use(supportRouter);
    });

    test('sends an administrator reply through WhatChimp and records the provider message id', async () => {
        const ticket = createTicket();
        SupportTicket.findById.mockResolvedValue(ticket);
        sendWhatChimpText.mockResolvedValue({ success: true, messageId: 'wamid.reply.1' });

        const response = await request(app)
            .post('/api/support/tickets/ticket-1/reply')
            .send({ text: 'Your request is being reviewed.' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ success: true, channel: 'whatsapp' });
        expect(sendWhatChimpText).toHaveBeenCalledWith({
            phone: '201108172258',
            message: 'Your request is being reviewed.'
        });
        expect(ticket.messages).toHaveLength(1);
        expect(ticket.messages[0]).toMatchObject({
            sender: 'admin',
            channel: 'whatsapp',
            direction: 'outbound',
            providerMessageId: 'wamid.reply.1',
            deliveryStatus: 'sent'
        });
        expect(ticket.save).toHaveBeenCalledTimes(1);
        expect(createSupportReplyNotifications).toHaveBeenCalledWith({ ticket, channel: 'whatsapp' });
        expect(Notification.create).not.toHaveBeenCalled();
    });

    test('records a portal reply when the WhatsApp conversation window has expired', async () => {
        const ticket = createTicket({ whatsappWindowExpiresAt: new Date(Date.now() - 1) });
        SupportTicket.findById.mockResolvedValue(ticket);

        const response = await request(app)
            .post('/api/support/tickets/ticket-1/reply')
            .send({ text: 'Late reply' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            channel: 'portal',
            whatsapp: {
                eligible: true,
                attempted: false,
                delivered: false,
                code: 'WHATSAPP_WINDOW_EXPIRED'
            }
        });
        expect(response.body.warning).toContain('صفحة الدعم فقط');
        expect(sendWhatChimpText).not.toHaveBeenCalled();
        expect(ticket.messages).toHaveLength(1);
        expect(ticket.messages[0]).toMatchObject({
            sender: 'admin',
            channel: 'portal',
            direction: 'outbound',
            deliveryStatus: 'portal_only'
        });
        expect(ticket.save).toHaveBeenCalledTimes(1);
        expect(createSupportReplyNotifications).toHaveBeenCalledWith({ ticket, channel: 'portal' });
    });

    test('keeps the portal copy when WhatChimp rejects a reply', async () => {
        const ticket = createTicket();
        SupportTicket.findById.mockResolvedValue(ticket);
        sendWhatChimpText.mockResolvedValue({
            success: false,
            code: 'WHATCHIMP_REQUEST_FAILED'
        });

        const response = await request(app)
            .post('/api/support/tickets/ticket-1/reply')
            .send({ text: 'Fallback copy' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            channel: 'portal',
            whatsapp: {
                eligible: true,
                attempted: true,
                delivered: false,
                code: 'WHATCHIMP_REQUEST_FAILED'
            }
        });
        expect(response.body.warning).toContain('صفحة الدعم فقط');
        expect(ticket.messages[0]).toMatchObject({ channel: 'portal', deliveryStatus: 'portal_only' });
        expect(createSupportReplyNotifications).toHaveBeenCalledWith({ ticket, channel: 'portal' });
    });

    test('sends and records a WhatsApp test message for an active WhatsApp ticket', async () => {
        const ticket = createTicket();
        SupportTicket.findById.mockResolvedValue(ticket);
        sendWhatChimpText.mockResolvedValue({ success: true, code: 'WHATCHIMP_SENT', messageId: 'wamid.test.1' });

        const response = await request(app)
            .post('/api/support/tickets/ticket-1/whatsapp-test');

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            whatsapp: {
                attempted: true,
                delivered: true,
                code: 'WHATCHIMP_SENT',
                messageId: 'wamid.test.1'
            }
        });
        expect(sendWhatChimpText).toHaveBeenCalledWith(expect.objectContaining({ phone: '201108172258' }));
        expect(ticket.messages).toHaveLength(1);
        expect(ticket.messages[0]).toMatchObject({
            sender: 'admin',
            senderName: 'اختبار المنظومة',
            channel: 'whatsapp',
            direction: 'outbound',
            providerMessageId: 'wamid.test.1',
            deliveryStatus: 'sent'
        });
        expect(createSupportReplyNotifications).toHaveBeenCalledWith({ ticket, channel: 'whatsapp' });
    });

    test('does not send a WhatsApp test message after the conversation window expires', async () => {
        const ticket = createTicket({ whatsappWindowExpiresAt: new Date(Date.now() - 1) });
        SupportTicket.findById.mockResolvedValue(ticket);

        const response = await request(app)
            .post('/api/support/tickets/ticket-1/whatsapp-test');

        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ success: false, code: 'WHATSAPP_WINDOW_EXPIRED' });
        expect(sendWhatChimpText).not.toHaveBeenCalled();
        expect(ticket.messages).toHaveLength(0);
        expect(ticket.save).not.toHaveBeenCalled();
    });

    test('creates a WhatsApp support test ticket for a phone and records a successful provider delivery', async () => {
        SupportTicket.findOne.mockReturnValue({ sort: jest.fn().mockResolvedValue(null) });
        sendWhatChimpText.mockResolvedValue({ success: true, code: 'WHATCHIMP_SENT', messageId: 'wamid.phone-test.1' });

        const response = await request(app)
            .post('/api/support/whatsapp-test')
            .send({ phone: '0940719000' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            ticketId: 'created-whatsapp-test',
            whatsapp: {
                attempted: true,
                delivered: true,
                code: 'WHATCHIMP_SENT',
                messageId: 'wamid.phone-test.1'
            }
        });
        expect(normalizeWhatsAppPhone).toHaveBeenCalledWith('0940719000');
        expect(sendWhatChimpText).toHaveBeenCalledWith(expect.objectContaining({ phone: '218940719000' }));
        const ticket = SupportTicket.mock.instances[0];
        expect(ticket).toMatchObject({
            entityType: 'whatsapp',
            phoneNormalized: '218940719000',
            status: 'answered'
        });
        expect(ticket.messages).toHaveLength(1);
        expect(ticket.messages[0]).toMatchObject({
            channel: 'whatsapp',
            direction: 'outbound',
            deliveryStatus: 'sent',
            providerMessageId: 'wamid.phone-test.1'
        });
        expect(ticket.save).toHaveBeenCalledTimes(1);
        expect(createSupportReplyNotifications).toHaveBeenCalledWith({ ticket, channel: 'whatsapp' });
    });

    test('keeps an auditable test ticket when WhatChimp rejects a phone-based test', async () => {
        SupportTicket.findOne.mockReturnValue({ sort: jest.fn().mockResolvedValue(null) });
        sendWhatChimpText.mockResolvedValue({ success: false, code: 'WHATCHIMP_REJECTED', message: 'Conversation window is not active.' });

        const response = await request(app)
            .post('/api/support/whatsapp-test')
            .send({ phone: '0940719000' });

        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({
            success: false,
            ticketId: 'created-whatsapp-test',
            whatsapp: { attempted: true, delivered: false, code: 'WHATCHIMP_REJECTED' }
        });
        const ticket = SupportTicket.mock.instances[0];
        expect(ticket.status).toBe('open');
        expect(ticket.messages[0]).toMatchObject({ channel: 'whatsapp', deliveryStatus: 'failed' });
        expect(ticket.save).toHaveBeenCalledTimes(1);
        expect(createSupportReplyNotifications).not.toHaveBeenCalled();
    });
});
