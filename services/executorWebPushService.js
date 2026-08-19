'use strict';

const WebPushSubscription = require('../models/WebPushSubscription');

const cleanId = (value) => String(value?._id || value || '').trim();

const getConfiguration = () => ({
    publicKey: String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim(),
    privateKey: String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim(),
    subject: String(process.env.WEB_PUSH_SUBJECT || 'mailto:support@ahrampay.com').trim()
});

const isConfigured = () => {
    const config = getConfiguration();
    return Boolean(config.publicKey && config.privateKey && config.subject);
};

const normalizeSubscription = (subscription) => {
    const endpoint = String(subscription?.endpoint || '').trim();
    const p256dh = String(subscription?.keys?.p256dh || '').trim();
    const auth = String(subscription?.keys?.auth || '').trim();
    if (!endpoint || !p256dh || !auth) {
        const error = new Error('INVALID_WEB_PUSH_SUBSCRIPTION');
        error.code = 'INVALID_WEB_PUSH_SUBSCRIPTION';
        throw error;
    }
    return { endpoint, subscription: { endpoint, expirationTime: subscription.expirationTime || null, keys: { p256dh, auth } } };
};

const upsertExecutorSubscription = async ({ employeeId, subscription }) => {
    const id = cleanId(employeeId);
    if (!id) throw new Error('INVALID_EXECUTOR_ID');
    const normalized = normalizeSubscription(subscription);
    return WebPushSubscription.findOneAndUpdate(
        { endpoint: normalized.endpoint },
        {
            $set: {
                subscription: normalized.subscription,
                userId: id,
                accountType: 'executor',
                active: true,
                lastError: ''
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const disableExecutorSubscription = async ({ employeeId, endpoint }) => {
    const query = {
        userId: cleanId(employeeId),
        accountType: 'executor',
        ...(String(endpoint || '').trim() ? { endpoint: String(endpoint).trim() } : {})
    };
    const result = await WebPushSubscription.updateMany(query, { $set: { active: false } });
    return Number(result.modifiedCount || 0);
};

const getExecutorWebPushStatus = async (employeeId) => {
    const id = cleanId(employeeId);
    const [activeSubscriptions, lastSubscription] = await Promise.all([
        WebPushSubscription.countDocuments({ userId: id, accountType: 'executor', active: true }),
        WebPushSubscription.findOne({ userId: id, accountType: 'executor' })
            .sort({ updatedAt: -1 })
            .select('lastSuccessAt lastError updatedAt active')
            .lean()
    ]);
    const config = getConfiguration();
    return {
        configured: isConfigured(),
        publicKey: config.publicKey,
        activeSubscriptions,
        lastSuccessAt: lastSubscription?.lastSuccessAt || null,
        lastError: lastSubscription?.lastError || '',
        subscribed: activeSubscriptions > 0
    };
};

const sendExecutorWebPush = async ({
    employeeIds = [],
    title,
    body,
    category = 'executor_update',
    data = {},
    collapseKey = '',
    ttl = 180,
    urgency = 'high'
}) => {
    const ids = [...new Set(employeeIds.map(cleanId).filter(Boolean))];
    if (!isConfigured() || ids.length === 0) {
        return { configured: isConfigured(), attempted: 0, sent: 0, failed: 0 };
    }

    const subscriptions = await WebPushSubscription.find({
        accountType: 'executor',
        userId: { $in: ids },
        active: true
    }).lean();
    if (!subscriptions.length) return { configured: true, attempted: 0, sent: 0, failed: 0 };

    const webpush = require('web-push');
    const config = getConfiguration();
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    const message = JSON.stringify({
        title: String(title || 'Ahram Pay - بوابة التنفيذ'),
        message: String(body || 'يوجد تحديث جديد في بوابة التنفيذ.'),
        tag: collapseKey || `${category}-${Date.now()}`,
        data: {
            ...data,
            category,
            collapseKey,
            url: data.url || data.route || '/executor-portal/dashboard'
        }
    });

    const results = await Promise.all(subscriptions.map(async (row) => {
        try {
            await webpush.sendNotification(row.subscription, message, {
                TTL: Math.max(60, Number(ttl) || 180),
                urgency
            });
            await WebPushSubscription.updateOne(
                { _id: row._id },
                { $set: { lastSuccessAt: new Date(), lastError: '', active: true } }
            );
            return true;
        } catch (error) {
            const expired = [404, 410].includes(Number(error.statusCode));
            await WebPushSubscription.updateOne(
                { _id: row._id },
                {
                    $set: {
                        active: !expired,
                        lastError: String(error.message || 'WEB_PUSH_FAILED').slice(0, 500)
                    }
                }
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

const sendExecutorWebPushTest = (employeeId) => sendExecutorWebPush({
    employeeIds: [employeeId],
    title: 'اختبار إشعارات Ahram Pay',
    body: 'تم ربط هذا المتصفح بنجاح بإشعارات بوابة التنفيذ.',
    category: 'executor_push_test',
    collapseKey: `executor-web-test-${cleanId(employeeId)}`,
    data: { url: '/executor-portal/settings', priority: 'high' }
});

module.exports = {
    disableExecutorSubscription,
    getConfiguration,
    getExecutorWebPushStatus,
    isConfigured,
    normalizeSubscription,
    sendExecutorWebPush,
    sendExecutorWebPushTest,
    upsertExecutorSubscription
};
