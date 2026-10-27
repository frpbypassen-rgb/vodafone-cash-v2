'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { resolveWorkspace } = require('../services/agentPortalWorkspaceService');
const service = require('../services/agentTelegramSettingsService');
const limit = rateLimit({ windowMs: 600000, max: 5, keyGenerator: req => `${req.session.accountType}:${req.session.clientId}`, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'انتظر قبل طلب ربط جديد.' } });
const handle = action => async (req, res) => {
    try { res.set('Cache-Control', 'private, no-store'); if (req.method !== 'GET' && !req.path.endsWith('/test') && req.path !== '/api/telegram/link') require('../utils/portalSettingsRevision').withRevision({}, req.body?.revision); return res.json({ success: true, data: await action(await resolveWorkspace(req), req.body || {}, req) }); }
    catch (error) { return res.status(error.statusCode || 500).json({ success: false, code: error.code || 'TELEGRAM_FAILED', error: error.statusCode ? error.message : 'تعذر تنفيذ طلب تيليجرام.' }); }
};
router.get('/api/telegram', handle(workspace => service.status(workspace)));
router.post('/api/telegram/link', limit, handle((workspace, body) => service.requestLink(workspace, body.name)));
router.post('/api/telegram/preferences', handle((workspace, body) => service.setEnabled(workspace, body.enabled, body.id, body.revision)));
router.post('/api/telegram/unlink', handle((workspace, body) => service.unlink(workspace, body.id, body.revision)));
router.post('/api/telegram/connections/:id/preferences', handle((workspace, body, req) => service.setEnabled(workspace, body.enabled, req.params.id, body.revision)));
router.post('/api/telegram/connections/:id/name', handle((workspace, body, req) => service.rename(workspace, req.params.id, body.name, body.revision)));
router.post('/api/telegram/connections/:id/remove', handle((workspace, body, req) => service.unlink(workspace, req.params.id, body.revision)));
router.post('/api/telegram/connections/:id/test', limit, handle((workspace, _body, req) => service.sendTest(workspace, req.params.id)));
router.post('/api/telegram/connections/:id/link', limit, handle((workspace, body, req) => service.requestLink(workspace, null, req.params.id, body.revision)));
module.exports = router;
