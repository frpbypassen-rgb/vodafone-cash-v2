'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../models/Notification', () => ({ create: jest.fn() }));
jest.mock('../models/SupportTicket', () => ({
    findById: jest.fn(),
    find: jest.fn()
}));
jest.mock('../services/whatsappService', () => ({ sendWhatChimpText: jest.fn() }));
jest.mock('../middlewares/auth', () => ({
    requireAuth: (req, _res, next) => {
        req.session = { adminName: 'Admin' };
        next();
    },
    requireMaster: (_req, _res, next) => next()
}));

const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');
const { sendWhatChimpText } = require('../services/whatsappService');
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
        expect(Notification.create).not.toHaveBeenCalled();
    });

    test('does not record a reply when the WhatsApp conversation window has expired', async () => {
        const ticket = createTicket({ whatsappWindowExpiresAt: new Date(Date.now() - 1) });
        SupportTicket.findById.mockResolvedValue(ticket);

        const response = await request(app)
            .post('/api/support/tickets/ticket-1/reply')
            .send({ text: 'Late reply' });

        expect(response.status).toBe(422);
        expect(response.body.success).toBe(false);
        expect(sendWhatChimpText).not.toHaveBeenCalled();
        expect(ticket.messages).toHaveLength(0);
        expect(ticket.save).not.toHaveBeenCalled();
    });
});
