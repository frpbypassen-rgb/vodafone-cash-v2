'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const ClientEmployee = require('../models/ClientEmployee');
const User = require('../models/User');
const MerchantWebhookEndpoint = require('../models/MerchantWebhookEndpoint');
const MerchantWebhookDelivery = require('../models/MerchantWebhookDelivery');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const { tenantMode } = require('../middlewares/tenantResolver');
const { encrypt } = require('../utils/encryption');
const { adminAccountScope, tenantWriteId } = require('../utils/tenantScope');
const { webhooksAllowed } = require('../services/merchantIntegrationService');
const { resolveCanonicalRole } = require('../services/companyAccessService');
const { requireClientAuth } = require('../middlewares/clientPortalAuth');
const clientPaths = suffix => ['/client' + suffix, '/agent-portal' + suffix];
const testLimiter = require('../utils/requestRateLimit')({ windowMs: 900000, max: 5, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => `${req.session.accountType}:${req.session.clientId}` });
const {
    EVENTS, deliverWebhook, normalizeEvents, publicEndpoint, requestWebhookRetry, validateWebhookUrl
} = require('../services/merchantWebhookService');
router.use([...clientPaths('/api/webhooks'), ...clientPaths('/api/webhook-deliveries')], (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});


const requestTenantId = (req) => req.tenantId || (req.tenant && req.tenant._id) || null;

// Company and agency portal lookups. Single mode keys only on the session id
// so a historical tenantId on that record still resolves. Multi mode also
// requires the exact request tenant. A missing tenant matches nothing.
// This is never adminAccountScope and never an empty collection filter.
const clientIdentityScope = (req, id) => {
    const query = { _id: id };
    if (tenantMode() === 'multi') {
        const tenantId = requestTenantId(req);
        query.tenantId = tenantId || { $in: [] };
    }
    return query;
};

const resolveClientIdentity = async (req) => {
    if (req.session.accountType === 'company') {
        const employee = await ClientEmployee.findOne(clientIdentityScope(req, req.session.clientId)).lean();
        if (!employee || employee.status !== 'active' || resolveCanonicalRole(employee) !== 'owner') throw new Error('WEBHOOK_ACCESS_DENIED');
        return { ownerModel: 'ClientCompany', ownerId: employee.companyId, actorName: employee.name || 'شركة' };
    }
    if (req.session.accountType === 'agent_staff') {
        throw new Error('WEBHOOK_ACCESS_DENIED');
    }
    if (req.session.accountType !== 'user') throw new Error('WEBHOOK_ACCESS_DENIED');
    const agent = await User.findOne({ ...clientIdentityScope(req, req.session.clientId), role: 'agent', status: 'active' }).select('_id name').lean();
    if (!agent) throw new Error('WEBHOOK_ACCESS_DENIED');
    return { ownerModel: 'User', ownerId: agent._id, actorName: agent.name || 'وكالة' };
};
const resolveClientOwner = async req => {
    const owner = { ...await resolveClientIdentity(req), tenantId: requestTenantId(req) };
    if (!await webhooksAllowed(owner)) throw new Error('WEBHOOK_DISABLED_BY_ADMIN');
    return owner;
};

// Single mode: company ownership is the boundary, including a legacy or
// missing tenantId on rows that company owns. Multi mode adds the exact
// request tenant. Never adminAccountScope and never an empty filter.
const endpointScope = (req, owner) => {
    const query = {
        ownerModel: owner.ownerModel,
        ownerId: owner.ownerId
    };
    if (tenantMode() === 'multi') {
        const tenantId = requestTenantId(req);
        query.tenantId = tenantId || { $in: [] };
    }
    return query;
};

router.get(clientPaths('/integrations/webhooks'), requireClientAuth, async (req, res) => {
    try {
        await resolveClientOwner(req);
        res.set('Cache-Control', 'private, no-store');
        return res.render('client/webhooks', {
            csrfToken: res.locals.csrfToken || '', events: EVENTS,
            portalBase: req.path.startsWith('/agent-portal') ? '/agent-portal' : '/client',
            webhookTheme: req.session.accountType === 'company' ? req.session.companyTheme : req.session.clientTheme
        });
    } catch (_) {
        return res.status(403).send('هذه الصفحة متاحة لمدير الشركة أو الوكالة فقط.');
    }
});

router.get(clientPaths('/api/webhooks'), requireClientAuth, async (req, res) => {
    try {
        const owner = await resolveClientOwner(req);
        const endpointQuery = endpointScope(req, owner);
        const endpoints = await MerchantWebhookEndpoint.find(endpointQuery).sort({ createdAt: -1 }).lean();
        const endpointIds = endpoints.map((item) => item._id);
        const deliveries = endpointIds.length ? await MerchantWebhookDelivery.find({ endpointId: { $in: endpointIds } })
            .sort({ createdAt: -1 }).limit(100).select('-payload').lean() : [];
        return res.json({ success: true, endpoints: endpoints.map(publicEndpoint), deliveries });
    } catch (error) {
        return res.status(403).json({ success: false, error: error.message });
    }
});

router.post(clientPaths('/api/webhooks'), requireClientAuth, async (req, res) => {
    try {
        const owner = await resolveClientOwner(req);
        const url = await validateWebhookUrl(req.body.url);
        const events = normalizeEvents(req.body.events);
        const secret = crypto.randomBytes(32).toString('hex');
        const endpoint = await MerchantWebhookEndpoint.create({
            tenantId: tenantWriteId(req), ownerModel: owner.ownerModel, ownerId: owner.ownerId,
            name: String(req.body.name || 'Webhook').trim().slice(0, 100),
            url, events, enabled: true, secretEncrypted: encrypt(secret), secretHint: secret.slice(-6),
            createdBy: owner.actorName
        });
        return res.status(201).json({ success: true, endpoint: publicEndpoint(endpoint), secret });
    } catch (error) {
        const invalid = error.message.startsWith('WEBHOOK_') || error.message.startsWith('INVALID_');
        return res.status(invalid ? 422 : 403).json({ success: false, error: error.message });
    }
});

router.patch(clientPaths('/api/webhooks/:id'), requireClientAuth, async (req, res) => {
    try {
        const owner = await resolveClientOwner(req);
        const update = {};
        if (req.body.name !== undefined) update.name = String(req.body.name).trim().slice(0, 100);
        if (req.body.url !== undefined) update.url = await validateWebhookUrl(req.body.url);
        if (req.body.events !== undefined) update.events = normalizeEvents(req.body.events);
        if (req.body.enabled !== undefined) {
            if (typeof req.body.enabled !== 'boolean') throw new Error('INVALID_WEBHOOK_STATE');
            update.enabled = req.body.enabled;
        }
        let secret;
        if (req.body.rotateSecret !== undefined && typeof req.body.rotateSecret !== 'boolean') throw new Error('INVALID_WEBHOOK_STATE');
        if (req.body.rotateSecret) {
            secret = crypto.randomBytes(32).toString('hex');
            update.secretEncrypted = encrypt(secret);
            update.secretHint = secret.slice(-6);
        }
        const endpoint = await MerchantWebhookEndpoint.findOneAndUpdate(
            { _id: req.params.id, ...endpointScope(req, owner) }, { $set: update }, { returnDocument: 'after', runValidators: true }
        );
        if (!endpoint) return res.status(404).json({ success: false, error: 'WEBHOOK_NOT_FOUND' });
        return res.json({ success: true, endpoint: publicEndpoint(endpoint), ...(secret ? { secret } : {}) });
    } catch (error) {
        return res.status(422).json({ success: false, error: error.message });
    }
});

router.delete(clientPaths('/api/webhooks/:id'), requireClientAuth, async (req, res) => {
    const owner = await resolveClientOwner(req).catch(() => null);
    if (!owner) return res.status(403).json({ success: false, error: 'WEBHOOK_ACCESS_DENIED' });
    const endpoint = await MerchantWebhookEndpoint.findOneAndDelete({ _id: req.params.id, ...endpointScope(req, owner) });
    if (!endpoint) return res.status(404).json({ success: false, error: 'WEBHOOK_NOT_FOUND' });
    await MerchantWebhookDelivery.deleteMany({ endpointId: endpoint._id });
    return res.json({ success: true });
});

router.post(clientPaths('/api/webhook-deliveries/:id/retry'), requireClientAuth, async (req, res) => {
    const owner = await resolveClientOwner(req).catch(() => null);
    if (!owner) return res.status(403).json({ success: false, error: 'WEBHOOK_ACCESS_DENIED' });
    const endpointIds = await MerchantWebhookEndpoint.find(endpointScope(req, owner)).distinct('_id');
    let delivery;
    try { delivery = await requestWebhookRetry({ _id: req.params.id, endpointId: { $in: endpointIds } }); }
    catch(error) { return res.status(error.statusCode || 500).json({ success:false, error:error.statusCode ? error.message : 'RETRY_FAILED' }); }
    const result = await deliverWebhook(delivery._id);
    return res.json({ success: true, result });
});

router.post(clientPaths('/api/webhooks/:id/test'), requireClientAuth, testLimiter, async (req, res) => {
    try {
        const owner = await resolveClientOwner(req);
        const endpoint = await MerchantWebhookEndpoint.findOne({ _id: req.params.id, ...endpointScope(req, owner), enabled: true }).lean();
        if (!endpoint) return res.status(404).json({ success: false, error: 'WEBHOOK_NOT_FOUND_OR_DISABLED' });
        const delivery = await MerchantWebhookDelivery.create({ ...owner, tenantId: endpoint.tenantId,
            endpointId: endpoint._id, eventId: 'test:' + crypto.randomUUID(), eventType: 'transfer.created',
            payload: { type: 'transfer.created', test: true, created_at: new Date().toISOString(), data: { message: 'AhramPay webhook connection test' } } });
        return res.json({ success: true, result: await deliverWebhook(delivery._id) });
    } catch (_) { return res.status(403).json({ success: false, error: 'WEBHOOK_TEST_DENIED' }); }
});

router.get('/admin/webhooks', requireAuth, requirePermission('reports.read'), (_req, res) => res.render('admin_webhooks'));
router.get('/admin/api/webhooks', requireAuth, requirePermission('reports.read'), async (req, res) => {
    const scope = adminAccountScope(req);
    const [endpoints, deliveries, summary] = await Promise.all([
        MerchantWebhookEndpoint.find(scope).sort({ lastFailureAt: -1, createdAt: -1 }).limit(200).lean(),
        MerchantWebhookDelivery.find(scope).sort({ createdAt: -1 }).limit(200).select('-payload').lean(),
        MerchantWebhookDelivery.aggregate([
            { $match: scope },
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ])
    ]);
    return res.json({ success: true, endpoints: endpoints.map(publicEndpoint), deliveries, summary: Object.fromEntries(summary.map((row) => [row._id, row.count])) });
});
router.post('/admin/api/webhook-deliveries/:id/retry', requireAuth, requirePermission('reports.manage'), async (req, res) => {
    let delivery;
    try { delivery = await requestWebhookRetry({ _id: req.params.id, ...adminAccountScope(req) }); }
    catch(error) { return res.status(error.statusCode || 500).json({ success:false, error:error.statusCode ? error.message : 'RETRY_FAILED' }); }
    return res.json({ success: true, result: await deliverWebhook(delivery._id) });
});

module.exports = router;
