'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const User = require('../models/User');
const MerchantWebhookEndpoint = require('../models/MerchantWebhookEndpoint');
const MerchantWebhookDelivery = require('../models/MerchantWebhookDelivery');
const { requireAuth, requirePermission } = require('../middlewares/auth');
const { encrypt } = require('../utils/encryption');
const { tenantScope, tenantWriteId } = require('../utils/tenantScope');
const {
    EVENTS, deliverWebhook, normalizeEvents, publicEndpoint, validateWebhookUrl
} = require('../services/merchantWebhookService');

const requireClientAuth = (req, res, next) => {
    if (req.session?.isClientLoggedIn && req.session?.clientId) return next();
    return res.status(401).json({ success: false, error: 'AUTH_REQUIRED' });
};

const resolveClientOwner = async (req) => {
    const scope = tenantScope(req);
    if (req.session.accountType === 'company') {
        const employee = await ClientEmployee.findOne({ _id: req.session.clientId, ...scope }).select('companyId role canManageCompany name').lean();
        if (!employee || !['owner'].includes(employee.role) && !employee.canManageCompany) throw new Error('WEBHOOK_ACCESS_DENIED');
        return { ownerModel: 'ClientCompany', ownerId: employee.companyId, actorName: employee.name || 'شركة' };
    }
    if (req.session.accountType === 'agent_staff') {
        const employee = await AgentEmployee.findOne({ _id: req.session.clientId, ...scope }).select('agentId canManageAgent name').lean();
        if (!employee?.canManageAgent) throw new Error('WEBHOOK_ACCESS_DENIED');
        return { ownerModel: 'User', ownerId: employee.agentId, actorName: employee.name || 'وكالة' };
    }
    const agent = await User.findOne({ _id: req.session.clientId, role: 'agent', ...scope }).select('_id name').lean();
    if (!agent) throw new Error('WEBHOOK_ACCESS_DENIED');
    return { ownerModel: 'User', ownerId: agent._id, actorName: agent.name || 'وكالة' };
};

const endpointScope = (req, owner) => ({
    ...tenantScope(req),
    ownerModel: owner.ownerModel,
    ownerId: owner.ownerId
});

router.get('/client/integrations/webhooks', requireClientAuth, async (req, res) => {
    try {
        await resolveClientOwner(req);
        return res.render('client/webhooks', { csrfToken: res.locals.csrfToken || '', events: EVENTS });
    } catch (_) {
        return res.status(403).send('هذه الصفحة متاحة لمدير الشركة أو الوكالة فقط.');
    }
});

router.get('/client/api/webhooks', requireClientAuth, async (req, res) => {
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

router.post('/client/api/webhooks', requireClientAuth, async (req, res) => {
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

router.patch('/client/api/webhooks/:id', requireClientAuth, async (req, res) => {
    try {
        const owner = await resolveClientOwner(req);
        const update = {};
        if (req.body.name !== undefined) update.name = String(req.body.name).trim().slice(0, 100);
        if (req.body.url !== undefined) update.url = await validateWebhookUrl(req.body.url);
        if (req.body.events !== undefined) update.events = normalizeEvents(req.body.events);
        if (req.body.enabled !== undefined) update.enabled = Boolean(req.body.enabled);
        let secret;
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

router.delete('/client/api/webhooks/:id', requireClientAuth, async (req, res) => {
    const owner = await resolveClientOwner(req).catch(() => null);
    if (!owner) return res.status(403).json({ success: false, error: 'WEBHOOK_ACCESS_DENIED' });
    const endpoint = await MerchantWebhookEndpoint.findOneAndDelete({ _id: req.params.id, ...endpointScope(req, owner) });
    if (!endpoint) return res.status(404).json({ success: false, error: 'WEBHOOK_NOT_FOUND' });
    await MerchantWebhookDelivery.deleteMany({ endpointId: endpoint._id });
    return res.json({ success: true });
});

router.post('/client/api/webhook-deliveries/:id/retry', requireClientAuth, async (req, res) => {
    const owner = await resolveClientOwner(req).catch(() => null);
    if (!owner) return res.status(403).json({ success: false, error: 'WEBHOOK_ACCESS_DENIED' });
    const endpointIds = await MerchantWebhookEndpoint.find(endpointScope(req, owner)).distinct('_id');
    const delivery = await MerchantWebhookDelivery.findOneAndUpdate(
        { _id: req.params.id, endpointId: { $in: endpointIds } },
        { $set: { status: 'pending', attemptCount: 0, nextAttemptAt: new Date(), lockedAt: null, lastError: '' } },
        { returnDocument: 'after' }
    );
    if (!delivery) return res.status(404).json({ success: false, error: 'DELIVERY_NOT_FOUND' });
    const result = await deliverWebhook(delivery._id);
    return res.json({ success: true, result });
});

router.get('/admin/webhooks', requireAuth, requirePermission('reports.read'), (_req, res) => res.render('admin_webhooks'));
router.get('/admin/api/webhooks', requireAuth, requirePermission('reports.read'), async (req, res) => {
    const scope = tenantScope(req);
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
    const delivery = await MerchantWebhookDelivery.findOneAndUpdate(
        { _id: req.params.id, ...tenantScope(req) },
        { $set: { status: 'pending', attemptCount: 0, nextAttemptAt: new Date(), lockedAt: null, lastError: '' } },
        { returnDocument: 'after' }
    );
    if (!delivery) return res.status(404).json({ success: false, error: 'DELIVERY_NOT_FOUND' });
    return res.json({ success: true, result: await deliverWebhook(delivery._id) });
});

module.exports = router;
