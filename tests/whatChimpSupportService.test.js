'use strict';

const SupportTicket = require('../models/SupportTicket');
const {
    buildPhoneLookupCandidates,
    hasActiveWhatsAppWindow,
    normalizeWhatChimpWebhookPayload,
    setPortalSupportReplyChannel,
    verifyWhatChimpWebhookRequest
} = require('../services/whatChimpSupportService');

describe('WhatChimp support bridge', () => {
    const originalSecret = process.env.WHATCHIMP_WEBHOOK_SECRET;

    afterAll(() => {
        if (originalSecret === undefined) delete process.env.WHATCHIMP_WEBHOOK_SECRET;
        else process.env.WHATCHIMP_WEBHOOK_SECRET = originalSecret;
    });

    test('normalizes an inbound WhatsApp message for the support inbox', () => {
        const event = normalizeWhatChimpWebhookPayload({
            data: {
                direction: 'incoming',
                subscriber_phone: '01108172258',
                subscriber_name: 'Test customer',
                message: 'Need help',
                wa_message_id: 'wamid.incoming.1',
                timestamp: 1786276800
            }
        });

        expect(event).toMatchObject({
            direction: 'inbound',
            sender: 'user',
            phoneNormalized: '201108172258',
            name: 'Test customer',
            text: 'Need help',
            providerMessageId: 'wamid.incoming.1',
            deliveryStatus: 'received'
        });
        expect(event.createdAt).toBeInstanceOf(Date);
    });

    test('keeps outbound AI messages distinct from administrator replies', () => {
        const event = normalizeWhatChimpWebhookPayload({
            message: {
                direction: 'outgoing',
                phone_number: '218912345678',
                text: { body: 'Automatic reply' },
                message_id: 'wamid.outgoing.1',
                source: 'ai_agent'
            }
        });

        expect(event).toMatchObject({
            direction: 'outbound',
            sender: 'ai',
            phoneNormalized: '218912345678',
            text: 'Automatic reply',
            providerMessageId: 'wamid.outgoing.1'
        });
    });

    test('normalizes a WhatsApp Cloud-style webhook envelope into an inbound support message', () => {
        const event = normalizeWhatChimpWebhookPayload({
            entry: [{
                changes: [{
                    value: {
                        contacts: [{ wa_id: '218940719000', profile: { name: 'WhatsApp customer' } }],
                        messages: [{
                            from: '218940719000',
                            id: 'wamid.cloud.1',
                            timestamp: '1786276800',
                            type: 'text',
                            text: { body: 'Test from WhatsApp' }
                        }]
                    }
                }]
            }]
        });

        expect(event).toMatchObject({
            direction: 'inbound',
            sender: 'user',
            phoneNormalized: '218940719000',
            name: 'WhatsApp customer',
            text: 'Test from WhatsApp',
            providerMessageId: 'wamid.cloud.1',
            deliveryStatus: 'received'
        });
    });

    test('builds national and international phone variants for linked accounts', () => {
        expect(buildPhoneLookupCandidates('01108172258')).toEqual(expect.arrayContaining([
            '01108172258',
            '201108172258',
            '+201108172258'
        ]));
    });

    test('requires a valid secret for the WhatChimp webhook', () => {
        process.env.WHATCHIMP_WEBHOOK_SECRET = 'support-secret';
        const request = {
            get: (name) => (name === 'x-whatchimp-webhook-secret' ? 'support-secret' : ''),
            query: {},
            body: {}
        };

        expect(verifyWhatChimpWebhookRequest(request)).toBe(true);
        expect(verifyWhatChimpWebhookRequest({ get: () => '', query: {}, body: {} })).toBe(false);
    });

    test('accepts a webhook secret supplied as a bearer token', () => {
        process.env.WHATCHIMP_WEBHOOK_SECRET = 'support-secret';
        const request = {
            get: (name) => (name === 'authorization' ? 'Bearer support-secret' : ''),
            query: {},
            body: {}
        };

        expect(verifyWhatChimpWebhookRequest(request)).toBe(true);
    });

    test('keeps an active WhatsApp ticket on the WhatsApp reply channel after a portal message', () => {
        const ticket = {
            channel: 'whatsapp',
            metadata: { replyChannel: 'whatsapp', whatsapp: { phoneNormalized: '201108172258' } },
            whatsappWindowExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
            markModified: jest.fn()
        };

        expect(hasActiveWhatsAppWindow(ticket)).toBe(true);
        expect(setPortalSupportReplyChannel(ticket)).toBe('whatsapp');
        expect(ticket.channel).toBe('whatsapp');
        expect(ticket.metadata.replyChannel).toBe('whatsapp');
        expect(ticket.markModified).toHaveBeenCalledWith('metadata');
    });

    test('uses the portal reply channel after the WhatsApp window expires', () => {
        const ticket = {
            channel: 'whatsapp',
            metadata: { replyChannel: 'whatsapp' },
            whatsappWindowExpiresAt: new Date(Date.now() - 1)
        };

        expect(hasActiveWhatsAppWindow(ticket)).toBe(false);
        expect(setPortalSupportReplyChannel(ticket)).toBe('portal');
        expect(ticket.channel).toBe('portal');
        expect(ticket.metadata.replyChannel).toBe('portal');
    });

    test('allows an unlinked WhatsApp contact to create a support ticket', async () => {
        const ticket = new SupportTicket({
            entityType: 'whatsapp',
            name: 'WhatsApp 201108172258',
            phone: '201108172258',
            phoneNormalized: '201108172258',
            channel: 'whatsapp',
            messages: [{
                sender: 'user',
                text: 'Need help',
                channel: 'whatsapp',
                direction: 'inbound'
            }]
        });

        await expect(ticket.validate()).resolves.toBeUndefined();
    });
});
