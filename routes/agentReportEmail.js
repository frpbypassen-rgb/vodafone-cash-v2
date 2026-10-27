'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { resolveWorkspace } = require('../services/agentPortalWorkspaceService');
const service = require('../services/agentReportEmailService');
const { sendTest } = require('../services/agentReportEmailWorker');
const { canReceiveAgencyStatement } = require('../utils/agentReportEmailAccess');
const actorKey = req => `${req.session.accountType}:${req.session.clientId}`;
const limited = (max, windowMs) => rateLimit({ windowMs, max, keyGenerator: actorKey, standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'طلبات كثيرة. حاول لاحقاً.' } });
const handle = action => async (req, res) => {
    try {
        const workspace = await resolveWorkspace(req);
        if (!canReceiveAgencyStatement(workspace)) return res.status(403).json({ success: false, error: 'لا توجد صلاحية لاستلام كشف الوكالة الشامل.' });
        res.set('Cache-Control', 'private, no-store');
        if (req.method !== 'GET' && !req.path.endsWith('/test')) require('../utils/portalSettingsRevision').withRevision({}, req.body?.revision);
        return res.json({ success: true, data: await action(workspace, req.body || {}) });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ success: false, code: error.code || 'REPORT_EMAIL_FAILED', error: error.statusCode ? error.message : 'تعذر تنفيذ الطلب. حاول لاحقاً.' });
    }
};
router.get('/api/report-email', handle(workspace => service.getStatus(workspace)));
router.post('/api/report-email/request-code', limited(6, 3600000), handle((workspace, body) => service.requestCode(workspace, body.email, new Date(), body.revision)));
router.post('/api/report-email/verify', limited(20, 900000), handle((workspace, body) => service.verifyCode(workspace, body.challengeId, body.code, new Date(), body.revision)));
router.post('/api/report-email/preferences', limited(30, 900000), handle((workspace, body) => service.setEnabled(workspace, body.enabled, body.revision)));
router.post('/api/report-email/test', limited(3, 3600000), handle(workspace => sendTest(workspace)));
module.exports = router;
