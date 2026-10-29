'use strict';
const router = require('express').Router();
const service = require('../services/businessLoginChoiceService');
const limiter = require('../utils/requestRateLimit')({
    windowMs: 300000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session?.tempClientId || req.sessionID),
    message: { success: false, error: 'محاولات كثيرة. انتظر خمس دقائق.' },
});
router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});
for (const action of ['send', 'change'])
    router.post('/' + action, limiter, async (req, res) => {
        try {
            const screen = await (action === 'send'
                ? service.send(req, req.body?.channel)
                : service.change(req));
            return res.json({ success: true, screen });
        } catch (error) {
            let screen;
            if (error.statusCode !== 401) {
                try {
                    screen = await service.view(req);
                } catch (_) {
                    /* No session details on an expired attempt. */
                }
            }
            return res
                .status(error.statusCode || 500)
                .json({
                    success: false,
                    error: error.statusCode ? error.message : 'تعذر إكمال الطلب. حاول مجددًا.',
                    restart: error.statusCode === 401,
                    ...(screen ? { screen } : {}),
                });
        }
    });
module.exports = router;
