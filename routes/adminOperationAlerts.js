'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const router = express.Router();
const Admin = require('../models/Admin');
const { AdminPushDevice: Device } = require('../models/AdminOperationAlert');
const alerts = require('../services/adminOperationAlertService');
const { getConfiguration, isConfigured } = require('../services/executorWebPushService');
const { tenantMode } = require('../middlewares/tenantResolver');
const { adminAccountScope } = require('../utils/tenantScope');
const { requireAdminActor } = require('../utils/adminActor');

router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
        if (!req.session?.isLoggedIn || !req.session.adminId) return res.status(401).json({ error: 'سجّل الدخول إلى الإدارة.' });
        req.alertActor = requireAdminActor(req);
        if (tenantMode() === 'multi' && !req.tenantId && !req.tenant?._id) return res.status(403).json({ error: 'تعذر تحديد نطاق الحساب.' });
        if (req.alertActor.id === 'master_admin' && req.session.adminRole === 'master') return next();
        if (!mongoose.isValidObjectId(req.alertActor.id)) return res.sendStatus(403);
        const admin = await Admin.findById(req.alertActor.id).select('status role permissions sessionVersion name').lean();
        if (!alerts.canRead(admin) || Number(admin.sessionVersion || 0) !== Number(req.session.adminSessionVersion || 0)) return res.status(403).json({ error: 'لا تملك صلاحية متابعة العمليات.' });
        req.alertActor.name = admin.name;
        return next();
    } catch (_) { return res.status(503).json({ error: 'تعذر التحقق من صلاحيات التنبيهات.' }); }
});
const wrap = handler => async (req, res) => {
    try { await handler(req, res); } catch (_) { res.status(503).json({ error: 'تعذر إكمال طلب التنبيهات. حاول مرة أخرى.' }); }
};
const mutations = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: true, legacyHeaders: false });
router.get('/', wrap(async (req, res) => {
    res.json({ enabled: alerts.enabled(), configured: isConfigured(), publicKey: getConfiguration().publicKey,
        adminId: req.alertActor.id, now: new Date(), alerts: await alerts.listAlerts(adminAccountScope(req)) });
}));
router.post('/acknowledge/:id', mutations, wrap(async (req, res) => {
    if (!/^[a-f0-9]{24}$/.test(req.params.id)) return res.sendStatus(400);
    const result = await alerts.acknowledge({ id: `api_pending:${req.params.id}`, scope: adminAccountScope(req), actor: req.alertActor });
    if (!result) return res.sendStatus(404);
    res.json({ success: true, alert: result });
}));
router.post('/subscribe', mutations, wrap(async (req, res) => {
    if (!isConfigured() || !alerts.enabled()) return res.status(503).json({ error: 'إشعارات الأجهزة غير مهيأة على السيرفر بعد.' });
    try {
        const deviceId = await alerts.registerDevice({ actor: req.alertActor, tenantId: req.tenantId || req.tenant?._id,
            allTenants: tenantMode() === 'single', subscription: req.body.subscription,
            sessionVersion: Number(req.session.adminSessionVersion || 0), sessionId: req.sessionID });
        res.json({ success: true, deviceId });
    } catch (error) {
        let endpointHost = '';
        try { endpointHost = new URL(req.body.subscription?.endpoint).hostname; } catch (_) {}
        require('../utils/logger').warn('Admin push registration rejected', { endpointHost, code: error.code || error.name });
        res.status(400).json({ error: 'تعذر تسجيل الجهاز. تأكد من دعم المتصفح أو عطّل أحد أجهزتك القديمة.' });
    }
}));
router.post('/unsubscribe', mutations, wrap(async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.body.deviceId || '')) return res.sendStatus(400);
    await Device.updateOne({ _id: req.body.deviceId, adminId: req.alertActor.id }, { $set: { active: false } });
    res.json({ success: true });
}));
router.get('/devices', wrap(async (req, res) => {
    res.json({ devices: await Device.find({ adminId: req.alertActor.id, active: true }).select('_id createdAt lastSuccessAt lastError').limit(10).lean() });
}));
router.post('/test', mutations, wrap(async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ error: 'مفاتيح Web Push غير مهيأة.' });
    const device = await Device.findOne({ _id: req.body.deviceId, adminId: req.alertActor.id, active: true }).lean();
    if (!device) return res.status(404).json({ error: 'فعّل إشعارات هذا الجهاز أولاً.' });
    await alerts.sendDevice(device, { id: `test:${Date.now()}`, adminId: req.alertActor.id, kind: 'test',
        title: 'اختبار تنبيهات الإدارة', body: 'تم إرسال إشعار اختباري. لا توجد عملية مالية.', url: '/transactions/operations' });
    res.json({ success: true });
}));
module.exports = router;
