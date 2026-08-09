'use strict';

const crypto = require('crypto');
const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const Employee = require('../models/Employee');
const { normalizeWhatsAppPhone } = require('./whatsappService');

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

const cleanText = (value, maxLength = 4096) => String(value ?? '').trim().slice(0, maxLength);

const getPath = (source, path) => path.split('.').reduce((value, key) => (
    value && typeof value === 'object' ? value[key] : undefined
), source);

const firstText = (sources, paths, maxLength = 4096) => {
    for (const source of sources) {
        for (const path of paths) {
            const value = getPath(source, path);
            if (typeof value === 'string' || typeof value === 'number') {
                const text = cleanText(value, maxLength);
                if (text) return text;
            }
        }
    }
    return '';
};

const firstValue = (sources, paths) => {
    for (const source of sources) {
        for (const path of paths) {
            const value = getPath(source, path);
            if (value !== undefined && value !== null && value !== '') return value;
        }
    }
    return null;
};

const collectPayloadObjects = (payload) => {
    const roots = [
        payload,
        payload?.data,
        payload?.message,
        payload?.data?.message,
        payload?.payload,
        payload?.payload?.data,
        Array.isArray(payload?.messages) ? payload.messages[0] : null,
        Array.isArray(payload?.data?.messages) ? payload.data.messages[0] : null
    ];
    return roots.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
};

const normalizeExternalPhone = (value) => {
    const raw = cleanText(value, 64);
    if (!raw) return '';

    try {
        return normalizeWhatsAppPhone(raw);
    } catch (_error) {
        const digits = raw.replace(/\D/g, '').replace(/^00/, '');
        return /^\d{8,15}$/.test(digits) ? digits : '';
    }
};

const buildPhoneLookupCandidates = (value) => {
    const raw = cleanText(value, 64);
    const rawDigits = raw.replace(/\D/g, '').replace(/^00/, '');
    const normalized = normalizeExternalPhone(raw);
    const candidates = new Set([raw, rawDigits, normalized].filter(Boolean));

    if (normalized) candidates.add(`+${normalized}`);
    if (normalized.startsWith('20') && normalized.length === 12) {
        candidates.add(`0${normalized.slice(2)}`);
    }
    if (normalized.startsWith('218') && normalized.length === 12) {
        candidates.add(`0${normalized.slice(3)}`);
    }

    return [...candidates];
};

const normalizeMessageType = (value, mediaUrl, text) => {
    const raw = cleanText(value, 64).toLowerCase();
    if (raw.includes('image')) return 'image';
    if (raw.includes('document') || raw.includes('file')) return 'document';
    if (raw.includes('audio') || raw.includes('voice')) return 'audio';
    if (raw.includes('video')) return 'video';
    if (raw.includes('text') || text) return 'text';
    return mediaUrl ? 'image' : 'unknown';
};

const normalizeTimestamp = (value) => {
    if (value === undefined || value === null || value === '') return new Date();
    const numeric = Number(value);
    const date = Number.isFinite(numeric) && String(value).trim() !== ''
        ? new Date(numeric < 100000000000 ? numeric * 1000 : numeric)
        : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
};

const detectDirection = (sources) => {
    const fromMe = firstValue(sources, ['from_me', 'fromMe', 'is_from_me', 'isOutbound']);
    if (fromMe === true || String(fromMe).toLowerCase() === 'true' || String(fromMe) === '1') return 'outbound';

    const marker = firstText(sources, ['direction', 'message_direction', 'event', 'event_type', 'type', 'status'], 128).toLowerCase();
    if (/(outbound|outgoing|sent|delivered|read|agent|admin|bot|ai)/.test(marker)) return 'outbound';
    if (/(inbound|incoming|received|customer|user)/.test(marker)) return 'inbound';
    return 'inbound';
};

const detectOutboundSender = (sources) => {
    const marker = firstText(sources, [
        'source', 'origin', 'sender_type', 'message_source', 'agent_name', 'automation', 'bot', 'ai'
    ], 256).toLowerCase();
    const automatic = firstValue(sources, ['is_ai', 'is_bot', 'automated', 'is_automated']);
    if (automatic === true || String(automatic).toLowerCase() === 'true' || /(ai|bot|agent|assistant|auto|automation)/.test(marker)) {
        return 'ai';
    }
    return 'admin';
};

const normalizeWhatChimpWebhookPayload = (payload) => {
    const sources = collectPayloadObjects(payload);
    if (!sources.length) return null;

    const rawPhone = firstText(sources, [
        'phone_number', 'phone', 'subscriber_phone', 'subscriber_phone_number', 'subscriber.phone',
        'subscriber.phone_number', 'contact.phone', 'sender.phone', 'from'
    ], 64);
    const phoneNormalized = normalizeExternalPhone(rawPhone);
    const text = firstText(sources, [
        'text.body', 'text', 'message_text', 'body', 'content.text', 'content', 'message.body', 'message'
    ]);
    const mediaUrl = firstText(sources, [
        'image.url', 'media.url', 'media_url', 'image_url', 'attachment.url', 'file.url'
    ], 2048);

    if (!phoneNormalized || (!text && !mediaUrl)) return null;

    const direction = detectDirection(sources);
    const sourceMarker = firstText(sources, ['source', 'origin', 'sender_type', 'message_source'], 128);
    const sender = direction === 'inbound' ? 'user' : detectOutboundSender(sources);
    const timestamp = normalizeTimestamp(firstValue(sources, [
        'timestamp', 'created_at', 'createdAt', 'message_timestamp', 'time'
    ]));

    return {
        direction,
        sender,
        senderName: direction === 'inbound' ? '' : (sender === 'ai' ? 'WhatsApp AI' : 'Support'),
        phone: rawPhone || phoneNormalized,
        phoneNormalized,
        name: firstText(sources, [
            'subscriber_name', 'name', 'subscriber.name', 'contact.name', 'sender.name', 'profile.name'
        ], 200),
        externalContactId: firstText(sources, [
            'subscriber_id', 'subscriber.id', 'contact_id', 'contact.id', 'sender.id', 'user_id'
        ], 200),
        providerMessageId: firstText(sources, [
            'wa_message_id', 'message_id', 'id', 'message.id', 'data.wa_message_id', 'data.message_id'
        ], 512),
        text,
        mediaUrl,
        messageType: normalizeMessageType(firstText(sources, ['message_type', 'type', 'media.type'], 64), mediaUrl, text),
        deliveryStatus: direction === 'outbound'
            ? firstText(sources, ['status', 'delivery_status'], 64)
            : 'received',
        sourceMarker,
        createdAt: timestamp
    };
};

const constantTimeEqual = (expected, received) => {
    const expectedBuffer = Buffer.from(String(expected || ''));
    const receivedBuffer = Buffer.from(String(received || ''));
    return expectedBuffer.length > 0
        && expectedBuffer.length === receivedBuffer.length
        && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
};

const verifyWhatChimpWebhookRequest = (req) => {
    const expected = cleanText(process.env.WHATCHIMP_WEBHOOK_SECRET, 512);
    if (!expected) return false;

    const submitted = [
        req.get?.('x-whatchimp-webhook-secret'),
        req.get?.('x-webhook-secret'),
        req.get?.('x-api-key'),
        req.query?.token,
        req.body?.token
    ];
    return submitted.some((value) => constantTimeEqual(expected, value));
};

const findAccountIdentity = async (phone) => {
    const candidates = buildPhoneLookupCandidates(phone);
    if (!candidates.length) return null;

    const query = { phone: { $in: candidates } };
    const modelCandidates = [
        { Model: ClientEmployee, entityType: 'client_company' },
        { Model: AgentEmployee, entityType: 'client_user' },
        { Model: SubAccount, entityType: 'sub_client' },
        { Model: User, entityType: 'client_user' },
        { Model: Employee, entityType: 'executor' }
    ];

    const matches = await Promise.all(modelCandidates.map(async ({ Model, entityType }) => {
        const account = await Model.findOne(query).select('_id name phone webUsername').lean();
        return account ? { entityType, entityId: account._id, account } : null;
    }));

    return matches.find(Boolean) || null;
};

const buildTicketMetadata = (ticket, event) => {
    const previous = ticket.metadata && typeof ticket.metadata === 'object'
        ? (typeof ticket.metadata.toObject === 'function' ? ticket.metadata.toObject() : { ...ticket.metadata })
        : {};
    return {
        ...previous,
        replyChannel: 'whatsapp',
        whatsapp: {
            ...(previous.whatsapp || {}),
            phoneNormalized: event.phoneNormalized,
            externalContactId: event.externalContactId || previous.whatsapp?.externalContactId || '',
            lastDirection: event.direction
        }
    };
};

const recordWhatChimpSupportMessage = async (event) => {
    if (!event) return { ignored: true, reason: 'EMPTY_EVENT' };

    if (event.providerMessageId) {
        const duplicate = await SupportTicket.findOne({ 'messages.providerMessageId': event.providerMessageId }).select('_id').lean();
        if (duplicate) return { duplicate: true, ticketId: duplicate._id };
    }

    const identity = await findAccountIdentity(event.phoneNormalized);
    let ticket = identity
        ? await SupportTicket.findOne({
            entityType: identity.entityType,
            entityId: identity.entityId,
            status: { $ne: 'closed' }
        }).sort({ updatedAt: -1 })
        : await SupportTicket.findOne({
            channel: 'whatsapp',
            phoneNormalized: event.phoneNormalized,
            status: { $ne: 'closed' }
        }).sort({ updatedAt: -1 });

    if (!ticket) {
        ticket = new SupportTicket({
            entityType: identity?.entityType || 'whatsapp',
            ...(identity ? { entityId: identity.entityId } : {}),
            name: event.name || identity?.account?.name || `WhatsApp ${event.phoneNormalized}`,
            phone: event.phone || identity?.account?.phone || event.phoneNormalized,
            phoneNormalized: event.phoneNormalized,
            channel: 'whatsapp',
            externalContactId: event.externalContactId || '',
            status: event.direction === 'inbound' ? 'open' : 'answered',
            messages: []
        });
    }

    ticket.name = ticket.name || event.name || `WhatsApp ${event.phoneNormalized}`;
    ticket.phone = ticket.phone || event.phone || event.phoneNormalized;
    ticket.phoneNormalized = event.phoneNormalized;
    ticket.channel = 'whatsapp';
    ticket.externalContactId = event.externalContactId || ticket.externalContactId || '';
    ticket.metadata = buildTicketMetadata(ticket, event);
    ticket.markModified('metadata');

    const message = {
        sender: event.sender,
        senderName: event.senderName || ticket.name,
        text: event.text || '',
        imageUrl: event.mediaUrl || '',
        channel: 'whatsapp',
        direction: event.direction,
        providerMessageId: event.providerMessageId || '',
        messageType: event.messageType,
        deliveryStatus: event.deliveryStatus || '',
        createdAt: event.createdAt
    };

    ticket.messages.push(message);
    if (event.direction === 'inbound') {
        ticket.status = 'open';
        ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1;
        ticket.lastWhatsAppInboundAt = event.createdAt;
        ticket.whatsappWindowExpiresAt = new Date(event.createdAt.getTime() + WHATSAPP_WINDOW_MS);
    } else {
        ticket.status = 'answered';
        ticket.unreadUser = (ticket.unreadUser || 0) + 1;
        ticket.lastWhatsAppOutboundAt = event.createdAt;
    }

    await ticket.save();
    return { ticket, message, duplicate: false };
};

module.exports = {
    WHATSAPP_WINDOW_MS,
    buildPhoneLookupCandidates,
    normalizeExternalPhone,
    normalizeWhatChimpWebhookPayload,
    recordWhatChimpSupportMessage,
    verifyWhatChimpWebhookRequest
};
