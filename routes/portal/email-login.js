'use strict';
const router = require('express').Router();
const { requireClientAuth } = require('../../middlewares/clientPortalAuth');
const rateLimit = require('../../utils/requestRateLimit');
const { resolveWorkspace } = require('../../services/businessPortalService');
const { resolveCanonicalRole } = require('../../services/companyAccessService');
const service = require('../../services/emailLoginEnrollmentService');
const { logAction } = require('../../services/auditService');
const models = {
    User: require('../../models/User'),
    ClientEmployee: require('../../models/ClientEmployee'),
    AgentEmployee: require('../../models/AgentEmployee'),
};
const context = async (req) => {
    const workspace = await resolveWorkspace(req);
    const Model = models[workspace.actorModel];
    if (!Model) throw Object.assign(new Error('غير متاح لهذا الحساب.'), { statusCode: 403 });
    const actor = await Model.findById(workspace.actor._id).select('+emailOtpEnrollment');
    if (!actor || actor.status !== 'active')
        throw Object.assign(new Error('انتهت الجلسة.'), { statusCode: 401 });
    return {
        actor,
        Model,
        sessionId: req.sessionID,
        kind: workspace.isCompany ? 'company' : 'agent',
        profileEmail: workspace.entity.businessProfile?.email,
        isOwner:
            workspace.actorModel === 'User' ||
            (workspace.isCompany && resolveCanonicalRole(actor) === 'owner'),
    };
};
router.use('/api/security/email-login', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});
router.get('/api/security/email-login', requireClientAuth, async (req, res) => {
    try {
        return res.json({ success: true, ...service.present(await context(req)) });
    } catch (error) {
        return res
            .status(error.statusCode || 500)
            .json({ success: false, error: 'تعذر التحقق من حالة حماية البريد.' });
    }
});
const limiter = rateLimit({
    windowMs: 300000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.clientId),
    message: { success: false, error: 'محاولات كثيرة. انتظر خمس دقائق.' },
});
for (const action of ['start', 'confirm'])
    router.post(`/api/security/email-login/${action}`, requireClientAuth, limiter, async (req, res) => {
        try {
            const ctx = await context(req);
            const result = await service[action]({
                ...ctx,
                password: req.body?.password,
                code: req.body?.code,
            });
            if (action === 'confirm')
                await logAction({
                    req,
                    action: 'SETTINGS_UPDATED',
                    performedById: ctx.actor._id,
                    performedByModel: ctx.Model.modelName,
                    targetId: ctx.actor._id,
                    targetModel: ctx.Model.modelName,
                    result: 'ناجح',
                    metadata: { section: 'email_login_security', enabled: true, portal: ctx.kind },
                }).catch(() => {});
            return res.json({ success: true, ...result });
        } catch (error) {
            return res.status(error.statusCode || 500).json({
                success: false,
                error: error.statusCode ? error.message : 'تعذر إكمال الطلب. حاول مجددًا.',
                code: error.code || 'FAILED',
            });
        }
    });
module.exports = router;
