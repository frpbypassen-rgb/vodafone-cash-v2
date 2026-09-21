'use strict';

const MobileDeviceSession = require('../models/MobileDeviceSession');
const { readExecutorManualPolicy } = require('../utils/executorManualPolicy');

const idOf = (value) => String(value?._id || value || '');

const enforceExecutorDeviceLimit = async ({ account, group = null, keepSessionId = null }) => {
    const policy = readExecutorManualPolicy(group || account?.groupId, account);
    const limit = policy.maxConcurrentDevices;
    const accountId = account?._id;
    if (!accountId) return { revoked: 0, limit };

    const active = await MobileDeviceSession.find({
        accountId,
        accountType: 'executor',
        active: true
    }).sort({ lastSeenAt: -1, createdAt: -1 }).select('_id sessionId').lean();

    const keepId = String(keepSessionId || '');
    const extras = active.filter((session) => String(session.sessionId) !== keepId);
    const overflow = extras.slice(Math.max(0, limit - (keepId ? 1 : 0)));
    if (overflow.length === 0) return { revoked: 0, limit };

    await MobileDeviceSession.updateMany(
        { _id: { $in: overflow.map((session) => session._id) } },
        {
            $set: {
                active: false,
                revokedAt: new Date(),
                revokeReason: 'device_limit_exceeded',
                lastSeenAt: new Date()
            }
        }
    );
    return { revoked: overflow.length, limit };
};

const listActiveExecutorDeviceSessions = async (accountId) => (
    MobileDeviceSession.find({
        accountId,
        accountType: 'executor',
        active: true
    }).sort({ lastSeenAt: -1 }).lean()
);

module.exports = {
    enforceExecutorDeviceLimit,
    idOf,
    listActiveExecutorDeviceSessions
};
