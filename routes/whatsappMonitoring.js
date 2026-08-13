'use strict';

const express = require('express');
const router = express.Router();

const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const { requireAuth } = require('../middlewares/auth');
const { getWhatChimpConfigurationStatus } = require('../services/whatsappService');
const { getPublicAppUrl, getReceiptShareSecret } = require('../services/receiptShareService');
const { DELIVERY_STAGE_LABELS } = require('../services/whatsappReceiptDeliveryService');

const DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped'];

router.get('/', requireAuth, async (req, res, next) => {
    try {
        const selectedStatus = String(req.query.status || '').trim();
        const search = String(req.query.search || '').trim().slice(0, 120);
        const filter = {};
        if (DELIVERY_STATUSES.includes(selectedStatus)) filter.status = selectedStatus;
        if (search) {
            const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$or = [
                { reference: { $regex: escaped, $options: 'i' } },
                { recipientPhone: { $regex: escaped, $options: 'i' } },
                { recipientName: { $regex: escaped, $options: 'i' } },
                { failureCode: { $regex: escaped, $options: 'i' } }
            ];
        }

        const [deliveries, pendingCount, failedCount, deliveredCount, readCount] = await Promise.all([
            WhatsAppDelivery.find(filter).sort({ updatedAt: -1 }).limit(250).lean(),
            WhatsAppDelivery.countDocuments({ status: { $in: ['pending', 'sending'] } }),
            WhatsAppDelivery.countDocuments({ status: 'failed' }),
            WhatsAppDelivery.countDocuments({ status: 'delivered' }),
            WhatsAppDelivery.countDocuments({ status: 'read' })
        ]);
        const baseConfiguration = getWhatChimpConfigurationStatus();
        const receiptLinkReady = Boolean(getPublicAppUrl() && getReceiptShareSecret());

        res.render('whatsapp_monitor', {
            deliveries,
            statuses: DELIVERY_STATUSES,
            selectedStatus,
            search,
            stageLabels: DELIVERY_STAGE_LABELS,
            summary: { pendingCount, failedCount, deliveredCount, readCount },
            configuration: {
                ready: Boolean(baseConfiguration.receiptReady && receiptLinkReady),
                missing: [
                    ...(baseConfiguration.missing || []),
                    ...(!receiptLinkReady ? ['PUBLIC_APP_URL (HTTPS)', 'RECEIPT_SHARE_SECRET'] : [])
                ]
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
