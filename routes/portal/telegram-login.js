'use strict';
const router = require('express').Router();
const { requireClientAuth } = require('../../middlewares/clientPortalAuth');
const { context } = require('../../services/businessLoginSecurityContext');
const service = require('../../services/telegramLoginSecurityService');
const { logAction } = require('../../services/auditService');
const limit = require('../../utils/requestRateLimit')({
    windowMs: 300000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.clientId),
    message: { success: false, error: 'محاولات كثيرة. انتظر خمس دقائق.' },
});
router.use('/api/security/telegram-login', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});
router.get('/api/security/telegram-login', requireClientAuth, async (req, res) => {
    try {
        return res.json({ success: true, ...service.present(await context(req)) });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر التحقق من حالة تليجرام.' });
    }
});
for (const [path, action] of [
    ['start', 'start'],
    ['confirm', 'confirm'],
    ['channel', 'requestChannel'],
    ['channel/confirm', 'confirmChannel'],
])
    router.post('/api/security/telegram-login/' + path, requireClientAuth, limit, async (req, res) => {
        try {
            const ctx = await context(req);
            const result = await service[action]({
                ...ctx,
                password: req.body?.password,
                code: req.body?.code,
                target: req.body?.target,
            });
            if (result.completed || result.linked)
                await logAction({
                    req,
                    action: 'SETTINGS_UPDATED',
                    performedById: ctx.actor._id,
                    performedByModel: ctx.Model.modelName,
                    targetId: ctx.actor._id,
                    targetModel: ctx.Model.modelName,
                    result: 'ناجح',
                    metadata: {
                        section: 'login_otp_channel',
                        portal: ctx.kind,
                        selected: result.selected,
                        linked: Boolean(result.linked),
                    },
                }).catch(() => {});
            return res.json({ success: true, ...result });
        } catch (error) {
            return res.status(error.statusCode || 500).json({
                success: false,
                code: error.code || 'FAILED',
                error: error.statusCode ? error.message : 'تعذر إكمال الطلب. حاول مجددًا.',
            });
        }
    });
module.exports = router;
