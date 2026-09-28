'use strict';

const express = require('express');
const router = express.Router();

const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { adminAccountScope } = require('../utils/tenantScope');
const { getWhatChimpTemplateReadiness } = require('../services/whatsappService');
const { getPublicAppUrl, getReceiptShareSecret } = require('../services/receiptShareService');
const { DELIVERY_STAGE_LABELS } = require('../services/whatsappReceiptDeliveryService');
const { isAdminActorError, requireAdminActor } = require('../utils/adminActor');
const {
    STOPPED_STATUS,
    countDeliveries,
    previewFailedRetries,
    retryFailedDeliveries,
    scopeListedDeliveries
} = require('../services/whatsappFailedDeliveryRetryService');

const DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped'];

const wantsJson = (req) => Boolean(
    req.xhr
    || String(req.headers?.accept || '').includes('application/json')
);

router.get('/', requireAuth, async (req, res, next) => {
    try {
        const selectedStatus = String(req.query.status || '').trim();
        const search = String(req.query.search || '').trim().slice(0, 120);
        const tenantFilter = adminAccountScope(req);
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

        const bulkRetrySummary = req.session?.whatsappBulkRetryResult || null;
        if (req.session && bulkRetrySummary) delete req.session.whatsappBulkRetryResult;

        const [rawDeliveries, pendingCount, failedCount, deliveredCount, readCount] = await Promise.all([
            WhatsAppDelivery.find(filter).sort({ updatedAt: -1 }).limit(250).lean(),
            countDeliveries({ status: { $in: ['pending', 'sending'] } }, tenantFilter),
            countDeliveries({ status: STOPPED_STATUS }, tenantFilter),
            countDeliveries({ status: 'delivered' }, tenantFilter),
            countDeliveries({ status: 'read' }, tenantFilter)
        ]);
        const deliveries = await scopeListedDeliveries(rawDeliveries, tenantFilter);
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
            canBulkRetry: req.session?.adminRole === 'master',
            bulkRetrySummary,
            configuration: {
                ready: Boolean(baseConfiguration.receiptOperational && receiptLinkReady),
                receiptTemplate: baseConfiguration.receiptTemplate || null,
                otpTemplate: baseConfiguration.otpTemplate || null,
                rateChangeReady: Boolean(baseConfiguration.rateChangeOperational),
                rateChangeTemplate: baseConfiguration.rateChangeTemplate || null,
                rateChangeMissing: baseConfiguration.rateChangeMissing || [],
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

router.get('/failed-retries/preview', requireAuth, requireMaster, async (req, res, next) => {
    try {
        const summary = await previewFailedRetries({
            tenantFilter: adminAccountScope(req),
            window: req.query.window
        });
        return res.json(summary);
    } catch (error) {
        return next(error);
    }
});

router.post('/failed-retries', requireAuth, requireMaster, async (req, res, next) => {
    try {
        const actor = requireAdminActor(req);
        const summary = await retryFailedDeliveries({
            tenantFilter: adminAccountScope(req),
            window: req.body?.window,
            actor,
            req
        });
        if (wantsJson(req)) {
            const status = summary.code === 'BULK_RETRY_BUSY' ? 409 : 200;
            return res.status(status).json(summary);
        }
        if (req.session) req.session.whatsappBulkRetryResult = summary;
        return res.redirect('/whatsapp-monitor?bulkRetry=1');
    } catch (error) {
        if (isAdminActorError(error)) {
            if (wantsJson(req)) return res.status(401).json({ success: false, error: error.publicMessage });
            return res.redirect('/login');
        }
        return next(error);
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
