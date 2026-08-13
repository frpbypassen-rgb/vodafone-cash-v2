'use strict';

const express = require('express');
const router = express.Router();

const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { getWhatChimpTemplateReadiness } = require('../services/whatsappService');
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
        const baseConfiguration = await getWhatChimpTemplateReadiness().catch(() => ({
            receiptReady: false,
            receiptOperational: false,
            missing: ['تعذر قراءة حالة قوالب WhatChimp']
        }));
        const receiptLinkReady = Boolean(getPublicAppUrl() && getReceiptShareSecret());

        res.render('whatsapp_monitor', {
            deliveries,
            statuses: DELIVERY_STATUSES,
            selectedStatus,
            search,
            query: req.query,
            stageLabels: DELIVERY_STAGE_LABELS,
            summary: { pendingCount, failedCount, deliveredCount, readCount },
            configuration: {
                ready: Boolean(baseConfiguration.receiptOperational && receiptLinkReady),
                receiptTemplate: baseConfiguration.receiptTemplate || null,
                otpTemplate: baseConfiguration.otpTemplate || null,
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

router.post('/receipts/:id/retry', requireAuth, requireMaster, async (req, res) => {
    try {
        const delivery = await WhatsAppDelivery.findById(req.params.id).select('kind transactionId reference');
        if (!delivery || delivery.kind !== 'receipt' || !delivery.transactionId) {
            return res.redirect('/whatsapp-monitor?retry=invalid');
        }
        const { sendCompletedTransactionReceipt } = require('../services/whatsappReceiptDeliveryService');
        const result = await sendCompletedTransactionReceipt(delivery.transactionId);
        return res.redirect(`/whatsapp-monitor?retry=${result.success ? 'success' : 'failed'}&search=${encodeURIComponent(delivery.reference || '')}`);
    } catch (_error) {
        return res.redirect('/whatsapp-monitor?retry=failed');
    }
});

module.exports = router;
