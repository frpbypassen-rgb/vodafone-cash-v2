'use strict';
const router = require('express').Router();
const { requireClientAuth } = require('../middlewares/clientPortalAuth');
const { resolve } = require('../services/customerNotificationContext'),
    service = require('../services/customerNotificationService'),
    email = require('../services/customerReportEmailService');
const rateLimit = require('../utils/requestRateLimit');
const limit = rateLimit({
    windowMs: 600000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.accountType) + ':' + String(req.session.clientId),
});
const linkLimit = rateLimit({
    windowMs: 3600000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session.accountType) + ':' + String(req.session.clientId),
});
router.use('/api/customer-notifications', requireClientAuth, (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});
const handle = (action) => async (req, res) => {
    try {
        if (
            [
                '/api/customer-notifications/email/request-code',
                '/api/customer-notifications/email/verify',
            ].includes(req.path)
        )
            require('../utils/portalSettingsRevision').withRevision({}, req.body?.revision);
        return res.json({ success: true, data: await action(await resolve(req), req.body || {}) });
    } catch (e) {
        return res
            .status(e.statusCode || 500)
            .json({
                success: false,
                code: e.code || 'NOTIFICATION_FAILED',
                error: e.statusCode ? e.message : 'تعذر إكمال الطلب. حدّث الصفحة وحاول مجددًا.',
            });
    }
};
router.get(
    '/api/customer-notifications',
    handle((ctx) => service.status(ctx))
);
router.post(
    '/api/customer-notifications/preferences',
    limit,
    handle((ctx, body) => service.save(ctx, body))
);
router.post(
    '/api/customer-notifications/email/request-code',
    linkLimit,
    handle((ctx, body) => email.requestCode(ctx, body.email, new Date(), body.revision))
);
router.post(
    '/api/customer-notifications/email/verify',
    limit,
    handle((ctx, body) => email.verifyCode(ctx, body.challengeId, body.code, new Date(), body.revision))
);
router.post(
    '/api/customer-notifications/email/test',
    linkLimit,
    handle((ctx) => require('../services/customerReportEmailWorker').sendTest(ctx))
);
router.post(
    '/api/customer-notifications/telegram/link',
    linkLimit,
    handle((ctx, body) => service.requestTelegram(ctx, body.revision))
);
router.post(
    '/api/customer-notifications/telegram/test',
    linkLimit,
    handle((ctx) => service.testTelegram(ctx))
);
router.post(
    '/api/customer-notifications/push/status',
    limit,
    handle((ctx, body) => service.deviceStatus(ctx, body.endpoint))
);
router.post(
    '/api/customer-notifications/push/subscribe',
    limit,
    handle((ctx, body) => service.subscribe(ctx, body.subscription))
);
router.post(
    '/api/customer-notifications/push/disable',
    limit,
    handle((ctx, body) => service.disable(ctx, body.endpoint))
);
router.post(
    '/api/customer-notifications/push/test',
    linkLimit,
    handle((ctx, body) => service.testPush(ctx, body.endpoint))
);
module.exports = router;
