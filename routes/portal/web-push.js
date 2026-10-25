'use strict';
const express = require('express');

const router = express.Router();

const companyWebPushService = require('../../services/companyWebPushService');

const { requireClientAuth } = require('../../middlewares/clientPortalAuth');

router.get('/api/web-push/status', requireClientAuth, async (req, res) => {
    try {
        if (req.session.accountType !== 'company') {
            return res.status(403).json({ success: false, error: 'COMPANY_PUSH_ONLY' });
        }
        const status = await companyWebPushService.getCompanyWebPushStatus(req.session.clientId);
        return res.json({ success: true, ...status });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'تعذر فحص إشعارات المتصفح.' });
    }
});

router.post('/api/web-push/subscribe', requireClientAuth, async (req, res) => {
    try {
        if (req.session.accountType !== 'company') {
            return res.status(403).json({ success: false, error: 'COMPANY_PUSH_ONLY' });
        }
        await companyWebPushService.upsertCompanySubscription({
            userId: req.session.clientId,
            accountType: 'company',
            subscription: req.body?.subscription,
        });
        return res.json({ success: true, subscribed: true });
    } catch (_error) {
        return res.status(400).json({ success: false, error: 'بيانات اشتراك الإشعارات غير صالحة.' });
    }
});

router.post('/api/web-push/unsubscribe', requireClientAuth, async (req, res) => {
    if (req.session.accountType !== 'company') {
        return res.status(403).json({ success: false, error: 'COMPANY_PUSH_ONLY' });
    }
    await companyWebPushService.disableCompanySubscription({
        userId: req.session.clientId,
        endpoint: req.body?.endpoint,
    });
    return res.json({ success: true, subscribed: false });
});

router.post('/api/web-push/test', requireClientAuth, async (req, res) => {
    try {
        if (req.session.accountType !== 'company') {
            return res.status(403).json({ success: false, error: 'COMPANY_PUSH_ONLY' });
        }
        const result = await companyWebPushService.sendCompanyWebPushTest(req.session.clientId);
        if (!result.configured) {
            return res
                .status(503)
                .json({ success: false, error: 'مفاتيح Web Push غير مضبوطة. راجع WEB_PUSH_* في البيئة.' });
        }
        if (!result.attempted)
            return res.status(409).json({ success: false, error: 'لا يوجد متصفح مسجل لاستقبال الاختبار.' });
        if (!result.sent)
            return res.status(502).json({ success: false, error: 'رفض مزود الإشعارات رسالة الاختبار.' });
        return res.json({ success: true, ...result });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'تعذر إرسال إشعار الاختبار.' });
    }
});

module.exports = router;
