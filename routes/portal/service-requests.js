'use strict';
const { getSupportIdentity } = require('../../services/portalSupportService');

const express = require('express');

const router = express.Router();

const ClientServiceRequest = require('../../models/ClientServiceRequest');

const { requireClientAuth } = require('../../middlewares/clientPortalAuth');

router.get('/api/service-requests', requireClientAuth, async (req, res) => {
    const rows = await ClientServiceRequest.find({ ownerId: String(req.session.clientId) })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
    return res.json({ success: true, requests: rows });
});

router.post('/api/service-requests', requireClientAuth, async (req, res) => {
    try {
        const type = String(req.body?.requestType || '');
        if (!['payment_request', 'scheduled_transfer', 'bill_payment'].includes(type)) {
            return res.status(422).json({ success: false, error: 'INVALID_REQUEST_TYPE' });
        }
        const identity = await getSupportIdentity(req);
        if (!identity.account) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
        const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
        const status = type === 'bill_payment' ? 'awaiting_integration' : 'pending_admin';
        const request = await ClientServiceRequest.create({
            requestType: type,
            ownerId: String(req.session.clientId),
            ownerType: req.session.accountType === 'sub_client' ? 'sub_client' : 'user',
            ownerName: String(identity.account.name || '').slice(0, 160),
            status,
            payload,
            audit: [
                {
                    action: 'created',
                    actorId: String(req.session.clientId),
                    actorName: String(identity.account.name || ''),
                },
            ],
        });
        return res.status(201).json({ success: true, request });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'SERVICE_REQUEST_CREATE_FAILED' });
    }
});

module.exports = router;
