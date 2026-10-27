'use strict';
const express = require('express');

const router = express.Router();

const WebPushSubscription = require('../../models/WebPushSubscription');

const Settings = require('../../models/Settings');

const { activatePendingRateUpdate } = require('../../services/rateChangeService');

const { buildPendingRateAlertForClient } = require('../../services/rateAlerts/rateAlertAudienceService');

const { requireClientAuth } = require('../../middlewares/clientPortalAuth');

router.get('/api/rate-alerts/current', requireClientAuth, async (req, res) => {
    try {
        await activatePendingRateUpdate({ app: req.app });
        const settings = (await Settings.findOne({}).lean()) || {};
        const alert = await buildPendingRateAlertForClient({
            accountType: req.session.accountType,
            clientId: req.session.clientId,
            settings,
        });
        return res.json({ success: true, alert });
    } catch (error) {
        console.error('[client/rate-alerts/current] failed:', error.message);
        return res.status(500).json({ success: false, error: 'RATE_ALERT_LOOKUP_FAILED' });
    }
});

router.post('/api/rate-alerts/subscribe', requireClientAuth, async (req, res) => {
    try {
        const subscription = req.body?.subscription;
        const endpoint = String(subscription?.endpoint || '').trim();
        if (!endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
            return res.status(422).json({ success: false, error: 'INVALID_PUSH_SUBSCRIPTION' });
        }
        await WebPushSubscription.findOneAndUpdate(
            { endpoint },
            {
                $inc: { settingsRevision: 1 },
                $set: {
                    subscription,
                    userId: String(req.session.clientId),
                    accountType: String(req.session.accountType || 'client'),
                    active: true,
                    lastError: '',
                },
            },
            { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
        );
        return res.json({ success: true });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'PUSH_SUBSCRIPTION_FAILED' });
    }
});

module.exports = router;
