'use strict';
const router = require('express').Router();
const { requireClientAuth } = require('../../middlewares/clientPortalAuth');
const rateLimit = require('../../utils/requestRateLimit');
const { context } = require('../../services/businessLoginSecurityContext');
const { logAction } = require('../../services/auditService');
const retail = require('../../utils/retailLoginMethods');
const challenge = require('../../utils/loginSecurityChallenge');

const path = '/api/security/login-methods';
router.use(path, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const limiter = rateLimit({
    windowMs: 300000, max: 12, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => String(req.session.clientId),
    message: { success: false, error: 'محاولات كثيرة. انتظر خمس دقائق.' },
});
const state = actor => ({ enabled: retail.enabledMethods(actor), preferred: retail.preferredMethod(actor) || '' });
const register = (method, handler) => router[method](path, requireClientAuth, ...(method === 'post' ? [limiter] : []), async (req, res) => {
    try {
        const ctx = await context(req);
        if (ctx.kind !== 'customer' || !ctx.isOwner)
            throw challenge.fail('NOT_ALLOWED', 'هذه الإعدادات متاحة لحساب العميل.', 403);
        return res.json({ success: true, ...await handler(ctx, req) });
    } catch (error) {
        return res.status(error.statusCode || 500).json({
            success: false,
            error: error.statusCode ? error.message : 'تعذر إكمال الطلب. حاول مجددًا.',
        });
    }
});
register('get', ({ actor }) => state(actor));
register('post', async (ctx, req) => {
    const { actor, Model } = ctx;
    const { action, method, password, confirmLast } = req.body || {};
    const active = retail.enabledMethods(actor);
    const current = retail.deliveryMethods(actor);
    const guard = {
        ...challenge.guard(actor),
        sessionVersion: actor.sessionVersion || { $in: [null, 0] },
        ...(actor.mfaEnabled ? { mfaEnabled: true } : { mfaEnabled: { $ne: true } }),
    };
    if (action === 'prefer' && (method === '' || active.includes(method))) {
        const result = await Model.updateOne(guard, { $set: { retailPreferredLoginMethod: method } });
        if (!result.matchedCount) throw challenge.fail('CHANGED', 'تغيّرت الإعدادات. حدّث الصفحة.', 409);
        return { ...state(actor), preferred: method };
    }
    if (action !== 'disable' || !current.includes(method))
        throw challenge.fail('METHOD_UNAVAILABLE', 'اختر وسيلة تحقق مفعّلة.');
    await challenge.password(actor, password);
    retail.requireRecentProof(ctx);
    if (active.length === 1 && confirmLast !== true)
        throw challenge.fail('LAST_METHOD', 'أكّد إيقاف آخر وسيلة تحقق أولًا.', 409);
    const remaining = current.filter(key => key !== method);
    const preferred = actor.retailPreferredLoginMethod === method ? '' : actor.retailPreferredLoginMethod || '';
    const nextChannel = remaining.includes(actor.otpDeliveryChannel) ? actor.otpDeliveryChannel : remaining[0] || 'whatsapp';
    const result = await Model.updateOne(guard, {
        $set: { retailLoginMethods: remaining, otpDeliveryChannel: nextChannel, retailPreferredLoginMethod: preferred },
        $inc: { emailOtpSettingsRevision: 1 },
        $unset: { emailOtpEnrollment: 1, telegramOtpEnrollment: 1, smsOtpEnrollment: 1, loginChannelAction: 1, ...challenge.unsetLogin },
    });
    if (!result.modifiedCount) throw challenge.fail('CHANGED', 'تغيّرت الإعدادات. حدّث الصفحة.', 409);
    const proof = req.session.retailLoginProof;
    if (proof && proof.method !== method) proof.revision += 1;
    else delete req.session.retailLoginProof;
    await logAction({
        req, action: 'SETTINGS_UPDATED', performedById: actor._id, performedByModel: Model.modelName,
        targetId: actor._id, targetModel: Model.modelName, result: 'ناجح',
        metadata: { section: 'retail_login_methods', method, enabled: false },
    }).catch(() => {});
    return { enabled: active.filter(key => key !== method), preferred };
});
module.exports = router;
