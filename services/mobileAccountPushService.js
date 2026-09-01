'use strict';

const MobilePushDevice = require('../models/MobilePushDevice');
const { sendPushToTokens, isInvalidPushTokenError } = require('./firebasePushService');
const logger = require('../utils/logger');

const idOf = (value) => String(value?._id || value || '').trim();

const validTargets = (targets = []) => [...new Map(
    targets
        .map((target) => ({ accountType: String(target?.accountType || ''), accountId: idOf(target?.accountId) }))
        .filter((target) => target.accountType && target.accountId)
        .map((target) => [`${target.accountType}:${target.accountId}`, target])
).values()];

const deliverMobileAccountPush = async ({
    targets,
    title,
    body,
    category = 'client_general',
    route = 'notifications',
    referenceId = ''
}) => {
    const audience = validTargets(targets);
    if (!audience.length) return { attempted: 0, sent: 0, failed: 0 };

    const devices = await MobilePushDevice.find({
        $or: audience,
        enabled: true,
        permissionStatus: { $in: ['authorized', 'provisional'] }
    }).select('_id token').lean();
    if (!devices.length) return { attempted: 0, sent: 0, failed: 0 };

    const result = await sendPushToTokens({
        tokens: devices.map((device) => device.token),
        title: String(title || 'إشعار جديد من Ahram Pay'),
        body: String(body || 'لديك تحديث جديد داخل حسابك.'),
        data: {
            action: 'open_client_notification',
            category,
            route,
            referenceId: String(referenceId || '')
        },
        visible: true,
        channelId: 'client_general_v1',
        sound: 'default',
        collapseKey: referenceId ? `client-notification-${referenceId}` : '',
        androidDataOnly: true
    });

    const byToken = new Map(devices.map((device) => [device.token, device]));
    await Promise.all((result.responses || []).map((response) => {
        const device = byToken.get(response.token);
        if (!device) return null;
        if (response.success) {
            return MobilePushDevice.updateOne(
                { _id: device._id },
                { $set: { lastSuccessfulPushAt: new Date(), lastErrorCode: '', lastErrorMessage: '' } }
            );
        }
        const code = response.error?.code || 'FCM_DELIVERY_FAILED';
        return MobilePushDevice.updateOne(
            { _id: device._id },
            {
                $set: {
                    enabled: isInvalidPushTokenError(response.error) ? false : true,
                    lastFailureAt: new Date(),
                    lastErrorCode: code,
                    lastErrorMessage: String(response.error?.message || '').slice(0, 500)
                }
            }
        );
    }).filter(Boolean));

    return { attempted: devices.length, sent: result.successCount || 0, failed: result.failureCount || 0 };
};

const deliverSafely = (payload) => {
    deliverMobileAccountPush(payload).catch((error) => {
        logger.error('Mobile account push delivery failed', {
            category: payload.category,
            error: error.message,
            code: error.code
        });
    });
};

module.exports = { deliverMobileAccountPush, deliverSafely };
