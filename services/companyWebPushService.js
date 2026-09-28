'use strict';

const mongoose = require('mongoose');
const WebPushSubscription = require('../models/WebPushSubscription');

const COMPANY_ACCOUNT_TYPES = Object.freeze(['company', 'client_company']);

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
    return {
        endpoint,
        subscription: {
            endpoint,
            expirationTime: subscription.expirationTime || null,
            keys: { p256dh, auth }
        }
    };
};

const upsertCompanySubscription = async ({ userId, accountType = 'company', subscription }) => {
    const id = cleanId(userId);
    if (!id) throw new Error('INVALID_COMPANY_USER');
    const normalized = normalizeSubscription(subscription);
    const storedType = COMPANY_ACCOUNT_TYPES.includes(String(accountType)) ? String(accountType) : 'company';
    return WebPushSubscription.findOneAndUpdate(
        { endpoint: normalized.endpoint },
        {
            $set: {
                subscription: normalized.subscription,
                userId: id,
                accountType: storedType,
                active: true,
                lastError: ''
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const disableCompanySubscription = async ({ userId, endpoint }) => {
    const query = {
        userId: cleanId(userId),
        accountType: { $in: [...COMPANY_ACCOUNT_TYPES] },
        ...(String(endpoint || '').trim() ? { endpoint: String(endpoint).trim() } : {})
    };
    const result = await WebPushSubscription.updateMany(query, { $set: { active: false } });
    return Number(result.modifiedCount || 0);
};

const getCompanyWebPushStatus = async (userId) => {
    const id = cleanId(userId);
    const [activeSubscriptions, lastSubscription] = await Promise.all([
        WebPushSubscription.countDocuments({
            userId: id,
            accountType: { $in: [...COMPANY_ACCOUNT_TYPES] },
            active: true
        }),
        WebPushSubscription.findOne({
            userId: id,
            accountType: { $in: [...COMPANY_ACCOUNT_TYPES] }
        }).sort({ updatedAt: -1 }).select('lastSuccessAt lastError updatedAt active').lean()
    ]);
    const config = getConfiguration();
    return {
        configured: isConfigured(),
        publicKey: config.publicKey,
        activeSubscriptions,
        lastSuccessAt: lastSubscription?.lastSuccessAt || null,
        lastError: lastSubscription?.lastError || '',
        subscribed: activeSubscriptions > 0,
        iosHomeScreenRequired: true
    };
};

const sendCompanyWebPush = async ({
    userIds = [],
    title,
    body,
    category = 'company_update',
    data = {},
    collapseKey = '',
    ttl = 180,
    urgency = 'high'
} = {}) => {
    const ids = [...new Set(userIds.map(cleanId).filter(Boolean))];
    if (!isConfigured() || ids.length === 0 || mongoose.connection.readyState !== 1) {
        return { configured: isConfigured(), attempted: 0, sent: 0, failed: 0 };
    }

    const subscriptions = await WebPushSubscription.find({
        accountType: { $in: [...COMPANY_ACCOUNT_TYPES] },
        userId: { $in: ids },
        active: true
    }).lean();
    if (!subscriptions.length) return { configured: true, attempted: 0, sent: 0, failed: 0 };

    const webpush = require('web-push');
    const config = getConfiguration();
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    const message = JSON.stringify({
        title: String(title || 'الأهرام باي - بوابة الشركات'),
        message: String(body || 'يوجد تحديث جديد في بوابة الشركات.'),
        tag: collapseKey || `${category}-${Date.now()}`,
        data: {
            ...data,
            category,
            collapseKey,
            url: data.url || data.route || '/client/services'
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

const sendCompanyWebPushTest = (userId) => sendCompanyWebPush({
    userIds: [userId],
    title: 'اختبار إشعارات بوابة الشركات',
    body: 'تم ربط هذا المتصفح بنجاح بإشعارات بوابة الشركات.',
    category: 'company_push_test',
    collapseKey: `company-web-test-${cleanId(userId)}`,
    data: { url: '/client/security', priority: 'high' }
});

const deliverCompanyWebPushSafely = (payload) => {
    Promise.resolve()
        .then(() => sendCompanyWebPush(payload))
        .catch(() => {});
};

module.exports = {
    COMPANY_ACCOUNT_TYPES,
    disableCompanySubscription,
    deliverCompanyWebPushSafely,
    getConfiguration,
    getCompanyWebPushStatus,
    isConfigured,
    normalizeSubscription,
    sendCompanyWebPush,
    sendCompanyWebPushTest,
    upsertCompanySubscription
};
