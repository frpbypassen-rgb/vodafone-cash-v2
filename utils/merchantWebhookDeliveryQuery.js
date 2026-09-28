'use strict';

// Same 2-minute lease claimDelivery uses. A `sending` row older than this
// can be claimed again, but the worker only selects that row when its lock
// is after MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER. Older stuck rows
// stay for manual review. Delivery is at-least-once: a merchant may already
// have accepted the HTTP call, and dedupes with x-ahrampay-event-id.
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 6;
const STALE_SENDING_RECLAIM_AFTER_ENV = 'MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER';

const staleSendingReclaimAfter = (env = process.env) => {
    const raw = String((env && env[STALE_SENDING_RECLAIM_AFTER_ENV]) || '').trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
};

const dueDeliveryClause = (now, maxAttempts) => ({
    status: { $in: ['pending', 'failed'] },
    nextAttemptAt: { $lte: now },
    attemptCount: { $lt: maxAttempts }
});

// Unset or invalid cutoff: do not auto-select stale `sending` rows.
// A cutoff that is not strictly older than the lease also selects nothing
// stale, because a row cannot be both after the cutoff and already expired.
const pendingWebhookFilter = (
    now = new Date(),
    env = process.env,
    maxAttempts = MAX_DELIVERY_ATTEMPTS
) => {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const cutoff = staleSendingReclaimAfter(env);
    if (!cutoff || cutoff.getTime() >= staleBefore.getTime()) {
        return dueDeliveryClause(now, maxAttempts);
    }
    return {
        attemptCount: { $lt: maxAttempts },
        $or: [
            {
                status: { $in: ['pending', 'failed'] },
                nextAttemptAt: { $lte: now }
            },
            {
                status: 'sending',
                lockedAt: { $gt: cutoff, $lte: staleBefore }
            }
        ]
    };
};

const isReclaimEligibleStaleSending = (row, now = new Date(), env = process.env) => {
    const cutoff = staleSendingReclaimAfter(env);
    if (!cutoff || !row || row.status !== 'sending' || !row.lockedAt) return false;
    const lockedAt = new Date(row.lockedAt).getTime();
    const staleBefore = now.getTime() - LOCK_TIMEOUT_MS;
    return lockedAt > cutoff.getTime()
        && lockedAt <= staleBefore
        && Number(row.attemptCount || 0) < MAX_DELIVERY_ATTEMPTS;
};

module.exports = {
    LOCK_TIMEOUT_MS,
    MAX_DELIVERY_ATTEMPTS,
    STALE_SENDING_RECLAIM_AFTER_ENV,
    dueDeliveryClause,
    isReclaimEligibleStaleSending,
    pendingWebhookFilter,
    staleSendingReclaimAfter
};
