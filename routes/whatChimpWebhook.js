'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const {
    normalizeWhatChimpDeliveryWebhook,
    normalizeWhatChimpWebhookPayload,
    recordWhatChimpSupportMessage,
    verifyWhatChimpWebhookRequest
} = require('../services/whatChimpSupportService');
const { updateReceiptDeliveryProviderStatus } = require('../services/whatsappReceiptDeliveryService');

router.post('/messages', async (req, res) => {
    if (!verifyWhatChimpWebhookRequest(req)) {
        logger.security('Rejected WhatChimp webhook request', {
            ip: req.ip,
            bodyKeys: Object.keys(req.body || {}).slice(0, 20)
        });
        return res.status(401).json({ success: false, error: 'Unauthorized webhook request.' });
    }

    try {
        const deliveryEvent = normalizeWhatChimpDeliveryWebhook(req.body);
        const deliveryResult = deliveryEvent
            ? await updateReceiptDeliveryProviderStatus({
                messageId: deliveryEvent.providerMessageId,
                status: deliveryEvent.status,
                rawStatus: deliveryEvent.status,
                reason: deliveryEvent.reason
            })
            : null;
        const event = normalizeWhatChimpWebhookPayload(req.body);
        if (!event) {
            logger.info('Processed WhatChimp delivery webhook', {
                bodyKeys: Object.keys(req.body || {}).slice(0, 20)
            });
            return res.status(deliveryResult?.updated ? 200 : 202).json({
                success: true,
                ignored: !deliveryResult?.updated,
                deliveryUpdated: Boolean(deliveryResult?.updated),
                reason: deliveryResult?.reason || ''
            });
        }

        const result = await recordWhatChimpSupportMessage(event);
        if (result.ticket) {
            req.app.get('io')?.emit('support:ticket-updated', {
                ticketId: String(result.ticket._id),
                channel: 'whatsapp',
                direction: event.direction
            });
        }
        logger.info('Processed WhatChimp webhook message', {
            direction: event.direction,
            messageType: event.messageType,
            duplicate: Boolean(result.duplicate),
            hasTicket: Boolean(result.ticket || result.ticketId),
            deliveryUpdated: Boolean(deliveryResult?.updated)
        });

        return res.status(200).json({
            success: true,
            duplicate: Boolean(result.duplicate),
            deliveryUpdated: Boolean(deliveryResult?.updated),
            ticketId: result.ticket ? String(result.ticket._id) : String(result.ticketId || '')
        });
    } catch (error) {
        logger.error('WhatChimp webhook processing failed', { error: error.message });
        return res.status(500).json({ success: false, error: 'Webhook processing failed.' });
    }
});

module.exports = router;
