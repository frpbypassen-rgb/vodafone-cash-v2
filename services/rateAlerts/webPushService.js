'use strict';

const WebPushSubscription = require('../../models/WebPushSubscription');

const getConfiguration = () => ({
    publicKey: String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim(),
    privateKey: String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim(),
    subject: String(process.env.WEB_PUSH_SUBJECT || 'mailto:support@ahrampay.com').trim()
});

const isConfigured = () => {
    const config = getConfiguration();
    return Boolean(config.publicKey && config.privateKey && config.subject);
};

const sendRateAlertWebPush = async ({ payload, audience = [] }) => {
    if (!isConfigured()) return { configured: false, attempted: 0, sent: 0, failed: 0 };
    const webpush = require('web-push');
    const config = getConfiguration();
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    const payloadByUserId = new Map();
    audience.forEach((recipient) => {
        (recipient.pushUserIds || []).forEach((userId) => {
            payloadByUserId.set(String(userId), recipient.payload);
        });
    });
    const targetUserIds = [...payloadByUserId.keys()];
    if (!targetUserIds.length && !payload) {
        return { configured: true, attempted: 0, sent: 0, failed: 0 };
    }
    const subscriptions = await WebPushSubscription.find({
        active: true,
        ...(targetUserIds.length ? { userId: { $in: targetUserIds } } : {})
    }).lean();
    const results = await Promise.all(subscriptions.map(async (row) => {
        const personalizedPayload = payloadByUserId.get(String(row.userId)) || payload;
        if (!personalizedPayload) return false;
        const delaySeconds = Number(personalizedPayload.delaySeconds || 60);
        const message = JSON.stringify({
            title: 'تنبيه طارئ: تحديث أسعار الصرف',
            message: `سيتم تطبيق السعر الجديد خلال ${personalizedPayload.countdown || '01:00'}.\n${personalizedPayload.rateChangesText || ''}`,
            tag: `rate-alert-${personalizedPayload.campaignReference || Date.now()}`,
            payload: personalizedPayload
        });
        try {
            await webpush.sendNotification(row.subscription, message, {
                TTL: Math.max(90, delaySeconds + 30),
                urgency: 'high'
            });
            await WebPushSubscription.updateOne({ _id: row._id }, { $set: { lastSuccessAt: new Date(), lastError: '' } });
            return true;
        } catch (error) {
            const expired = [404, 410].includes(Number(error.statusCode));
            await WebPushSubscription.updateOne(
                { _id: row._id },
                { $set: { active: !expired, lastError: String(error.message || 'PUSH_FAILED').slice(0, 500) } }
            );
            return false;
        }
    }));
    return {
        configured: true,
        attempted: results.length,
        sent: results.filter(Boolean).length,
        failed: results.filter((result) => !result).length
    };
};

module.exports = { getConfiguration, isConfigured, sendRateAlertWebPush };
