'use strict';
const router = require('express').Router();
const { requireClientAuth } = require('../middlewares/clientPortalAuth');
const { resolve } = require('../services/customerNotificationContext');
const service = require('../services/retailOperationDetailsService');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
router.use('/api/retail-transactions', requireClientAuth, (_req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
});
router.get('/api/retail-transactions/:id', async (req, res) => {
    try {
        const ctx = await resolve(req);
        const tx = await service.findOwn(ctx, req.params.id);
        res.json({ success: true, transaction: service.present(tx, ctx.actorModel) });
    } catch (error) {
        res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'تعذر تحميل تفاصيل العملية. أعد المحاولة.',
        });
    }
});
router.get('/api/retail-transactions/:id/proof/:index', async (req, res) => {
    try {
        const ctx = await resolve(req);
        const tx = await service.findOwn(ctx, req.params.id);
        const id = service.proof(tx, req.params.index);
        await streamProofImage(proofSourceUrl(id), res);
    } catch (error) {
        if (!res.headersSent) res.status(error.statusCode || 500).json({ error: 'تعذر تحميل صورة الإثبات.' });
    }
});
module.exports = router;
