'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const {
    normalizeWhatChimpWebhookPayload,
    recordWhatChimpSupportMessage,
    verifyWhatChimpWebhookRequest
} = require('../services/whatChimpSupportService');

router.post('/messages', async (req, res) => {
    if (!verifyWhatChimpWebhookRequest(req)) {
        logger.security('Rejected WhatChimp webhook request', { ip: req.ip });
        return res.status(401).json({ success: false, error: 'Unauthorized webhook request.' });
    }

    try {
        const event = normalizeWhatChimpWebhookPayload(req.body);
        if (!event) {
            return res.status(202).json({ success: true, ignored: true, reason: 'UNSUPPORTED_PAYLOAD' });
        }

        const result = await recordWhatChimpSupportMessage(event);
        if (result.ticket) {
            req.app.get('io')?.emit('support:ticket-updated', {
                ticketId: String(result.ticket._id),
                channel: 'whatsapp',
                direction: event.direction
            });
        }

        return res.status(200).json({
            success: true,
            duplicate: Boolean(result.duplicate),
            ticketId: result.ticket ? String(result.ticket._id) : String(result.ticketId || '')
        });
    } catch (error) {
        logger.error('WhatChimp webhook processing failed', { error: error.message });
        return res.status(500).json({ success: false, error: 'Webhook processing failed.' });
    }
});

module.exports = router;
