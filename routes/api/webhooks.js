const express = require('express');
const router = express.Router();
const webhookNotificationService = require('../../services/webhookNotificationService');
const ClientCompany = require('../../models/ClientCompany');
const logger = require('../../utils/logger');

router.get('/config', async (req, res) => {
    try {
        const companyId = req.session.companyId || req.user?.companyId;
        if (!companyId) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const company = await ClientCompany.findById(companyId).select('webhookUrl webhookEnabled webhookSecret');
        if (!company) return res.status(404).json({ success: false, error: 'Company not found' });
        res.json({ success: true, data: { webhookUrl: company.webhookUrl || '', webhookEnabled: company.webhookEnabled || false }});
    } catch (error) {
        logger.error('Failed to get webhook config', { error: error.message });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.post('/config', async (req, res) => {
    try {
        const companyId = req.session.companyId || req.user?.companyId;
        if (!companyId) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const { webhookUrl, webhookSecret, webhookEnabled } = req.body;
        if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) {
            return res.status(400).json({ success: false, error: 'Invalid webhook URL' });
        }
        const updateData = {};
        if (webhookUrl !== undefined) updateData.webhookUrl = webhookUrl;
        if (webhookSecret !== undefined) updateData.webhookSecret = webhookSecret;
        if (webhookEnabled !== undefined) updateData.webhookEnabled = webhookEnabled;
        const company = await ClientCompany.findByIdAndUpdate(companyId, updateData, { new: true });
        if (!company) return res.status(404).json({ success: false, error: 'Company not found' });
        logger.info('Webhook configuration updated', { companyId });
        res.json({ success: true, message: 'Webhook configuration updated successfully' });
    } catch (error) {
        logger.error('Failed to update webhook config', { error: error.message });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

router.post('/test', async (req, res) => {
    try {
        const companyId = req.session.companyId || req.user?.companyId;
        if (!companyId) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const testPayload = { event: 'webhook.test', timestamp: new Date().toISOString(), message: 'Test webhook from Al-Ahram Pay', companyId };
        const result = await webhookNotificationService.sendNotification(companyId, testPayload, 'webhook.test');
        if (result.success) {
            res.json({ success: true, message: 'Test webhook sent successfully' });
        } else {
            res.status(400).json({ success: false, message: 'Failed to send test webhook', reason: result.reason || result.error });
        }
    } catch (error) {
        logger.error('Webhook test failed', { error: error.message });
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;
