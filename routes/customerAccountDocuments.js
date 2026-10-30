'use strict';
const router = require('express').Router(),
    multer = require('multer');
const service = require('../services/customerAccountDocuments');
const { requireClientAuth } = require('../middlewares/clientPortalAuth');
const rateLimit = require('../utils/requestRateLimit');
const { logAction } = require('../services/auditService');
const limit = rateLimit({
    windowMs: 3600000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.accountType) + ':' + req.session.clientId,
});
const receive = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
}).single('document');
router.use('/api/account-documents', requireClientAuth, async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
        req.documentContext = await service.ownContext(req);
        next();
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'تعذر تحميل الوثائق.' });
    }
});
router.get('/api/account-documents', (req, res) => res.json(service.status(req.documentContext.actor)));
router.get('/api/account-documents/:id', async (req, res) => {
    try {
        await service.download(req.documentContext.actor, req.params.id, res);
    } catch (e) {
        res.status(e.statusCode || 500).send(e.statusCode ? e.message : 'تعذر تحميل الوثيقة.');
    }
});
router.post('/api/account-documents', limit, (req, res) => {
    receive(req, res, async (error) => {
        if (error) return res.status(422).json({ error: 'اختر ملفًا واحدًا لا يتجاوز 5 ميجابايت.' });
        try {
            const result = await service.upload(req.documentContext, req.body, req.file);
            await logAction({
                req,
                action: 'CUSTOMER_DOCUMENT_SUBMITTED',
                performedById: req.documentContext.actor._id,
                performedByModel: req.documentContext.Model.modelName,
                targetId: req.documentContext.actor._id,
                targetModel: req.documentContext.Model.modelName,
                metadata: result,
            });
            return res.json({ success: true });
        } catch (e) {
            return res
                .status(e.statusCode || 500)
                .json({
                    error: e.statusCode
                        ? e.message
                        : 'تعذر تأكيد رفع الوثيقة. حدّث الحالة قبل إعادة المحاولة.',
                });
        }
    });
});
module.exports = router;
