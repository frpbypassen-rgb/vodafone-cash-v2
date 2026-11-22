'use strict';
const router = require('express').Router();
const { requireClientAuth } = require('../../middlewares/clientPortalAuth');
const rateLimit = require('../../utils/requestRateLimit');
const { context } = require('../../services/businessLoginSecurityContext');
const service = require('../../services/smsLoginEnrollmentService');
const { logAction } = require('../../services/auditService');

const path = '/api/security/sms-login';
router.use(path, (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});
const limiter = rateLimit({
    windowMs: 300000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.clientId),
    message: { success: false, error: 'محاولات كثيرة. انتظر خمس دقائق.' },
});
const handle = (action) => async (req, res) => {
    try {
        const ctx = await context(req);
        const state = await service[action]({ ...ctx, password: req.body?.password, code: req.body?.code });
        if (action === 'confirm' && state.stage === 'complete')
            await logAction({
                req,
                action: 'SETTINGS_UPDATED',
                performedById: ctx.actor._id,
                performedByModel: ctx.Model.modelName,
                targetId: ctx.actor._id,
                targetModel: ctx.Model.modelName,
                result: 'ناجح',
                metadata: { section: 'sms_login_security', enabled: true, portal: ctx.kind },
            }).catch(() => {});
        return res.json({ success: true, ...state });
    } catch (error) {
        return res.status(error.statusCode || 500).json({
            success: false,
            error: error.statusCode ? error.message : 'تعذر إكمال الطلب. حاول مجددًا.',
            code: error.statusCode ? error.code : 'FAILED',
        });
    }
};
router.get(path, requireClientAuth, handle('present'));
router.post(path + '/start', requireClientAuth, limiter, handle('start'));
router.post(path + '/confirm', requireClientAuth, limiter, handle('confirm'));
module.exports = router;
