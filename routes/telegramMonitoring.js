'use strict';
const express = require('express');
const router = express.Router();
const TelegramDelivery = require('../models/TelegramDelivery');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { adminAccountScope } = require('../utils/tenantScope');

router.get('/', requireAuth, async (req, res, next) => {
    try {
        const status = String(req.query.status || '').trim();
        const search = String(req.query.search || '').trim().slice(0, 100);
        const filter = {};
        if (['sending', 'sent', 'failed', 'skipped'].includes(status)) filter.status = status;
        if (search) filter.$or = [{ reference: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { chatId: new RegExp(search, 'i') }, { failureReason: new RegExp(search, 'i') }];
        const deliveries = await TelegramDelivery.find({ ...filter, ...adminAccountScope(req) }).sort({ updatedAt: -1 }).limit(250).lean();
        const summary = await TelegramDelivery.aggregate([{ $match: { ...adminAccountScope(req) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
        const counts = Object.fromEntries(summary.map((row) => [row._id, row.count]));
        return res.render('telegram_monitor', { deliveries, search, status, counts });
    } catch (error) { return next(error); }
});

router.post('/:id/retry', requireAuth, requireMaster, async (req, res) => {
    const delivery = await TelegramDelivery.findById(req.params.id).select('transactionId reference');
    if (!delivery) return res.redirect('/telegram-monitor?retry=missing');
    const { sendCompletedTransactionReceipt } = require('../services/whatsappReceiptDeliveryService');
    const result = await sendCompletedTransactionReceipt(delivery.transactionId).catch(() => ({ success: false }));
    return res.redirect(`/telegram-monitor?retry=${result.success ? 'success' : 'failed'}&search=${encodeURIComponent(delivery.reference || '')}`);
});
module.exports = router;
