'use strict';
const crypto = require('crypto');
const mongoose = require('mongoose');
const { normalizeIp } = require('../utils/merchantIpPolicy');
const codes = new Set([
    'IP_NOT_ALLOWED',
    'WEBHOOK_DELIVERY_FAILED',
    'WEBHOOK_ADMIN_DISABLED',
    'IDEMPOTENCY_CONFLICT',
    'IDEMPOTENCY_IN_PROGRESS',
    'FINANCIAL_TRANSACTIONS_UNAVAILABLE',
    'IDEMPOTENCY_INDEX_UNAVAILABLE',
]);
let pending = 0;
const recordEvent = (owner, code, details = {}) => {
    if (
        !codes.has(code) ||
        !['ClientCompany', 'User'].includes(owner?.ownerModel) ||
        !owner.ownerId ||
        mongoose.connection?.readyState !== 1 ||
        pending >= 16
    )
        return Promise.resolve();
    const operation = ['balance', 'transfer', 'status', 'webhook'].includes(
        details.operation,
    )
        ? details.operation
        : 'webhook';
    const now = new Date(),
        bucket = Math.floor(now.getTime() / 300000);
    const key = crypto
        .createHash('sha256')
        .update(
            JSON.stringify([
                String(owner.tenantId || ''),
                owner.ownerModel,
                String(owner.ownerId),
                code,
                operation,
                bucket,
            ]),
        )
        .digest('hex');
    pending++;
    const task = require('../models/MerchantIntegrationEvent')
        .updateOne(
            { bucketKey: key },
            {
                $setOnInsert: {
                    tenantId: owner.tenantId || null,
                    ownerModel: owner.ownerModel,
                    ownerId: owner.ownerId,
                    bucketKey: key,
                    code,
                    operation,
                    firstSeenAt: now,
                },
                $set: {
                    lastSeenAt: now,
                    expiresAt: new Date(now.getTime() + 7 * 86400000),
                    sourceIp: normalizeIp(details.sourceIp) || undefined,
                    httpStatus: Number.isInteger(details.httpStatus)
                        ? details.httpStatus
                        : undefined,
                },
                $inc: { count: 1 },
            },
            { upsert: true, maxTimeMS: 300 },
        )
        .exec()
        .catch(() => {})
        .finally(() => {
            pending--;
        });
    let timer;
    const bounded = new Promise((resolve) => {
        timer = setTimeout(resolve, 500);
        timer.unref?.();
    });
    return Promise.race([task, bounded]).finally(() => clearTimeout(timer));
};
const listEvents = async (scope) =>
    require('../models/MerchantIntegrationEvent')
        .find({ ...scope, expiresAt: { $gt: new Date() } })
        .select('code operation httpStatus sourceIp count lastSeenAt -_id')
        .sort({ lastSeenAt: -1 })
        .limit(10)
        .maxTimeMS(1500)
        .lean();
const ensureIndexes = () =>
    require('../models/MerchantIntegrationEvent').createIndexes();
module.exports = { recordEvent, listEvents, ensureIndexes };
