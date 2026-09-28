'use strict';

// Read-only listing of stuck `sending` webhook deliveries.
// Prints counts and delivery ids only. It does not send, update, or delete.
// Resending any of these rows is a separate approved step.

const {
    LOCK_TIMEOUT_MS,
    isReclaimEligibleStaleSending,
    staleSendingReclaimAfter
} = require('../utils/merchantWebhookDeliveryQuery');

const listStaleSendingWebhooks = async (model, now = new Date(), env = process.env) => {
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const cutoff = staleSendingReclaimAfter(env);
    const rows = await model.find({
        status: 'sending',
        lockedAt: { $lte: staleBefore }
    }).select('_id lockedAt attemptCount status').lean();

    const manualReviewIds = [];
    const reclaimEligibleIds = [];
    rows.forEach((row) => {
        const id = String(row._id);
        if (isReclaimEligibleStaleSending(row, now, env)) reclaimEligibleIds.push(id);
        else manualReviewIds.push(id);
    });
    manualReviewIds.sort();
    reclaimEligibleIds.sort();
    return {
        readOnly: true,
        lockTimeoutMs: LOCK_TIMEOUT_MS,
        reclaimAfter: cutoff ? cutoff.toISOString() : null,
        staleSendingCount: rows.length,
        manualReviewCount: manualReviewIds.length,
        manualReviewIds,
        reclaimEligibleCount: reclaimEligibleIds.length,
        reclaimEligibleIds
    };
};

const main = async () => {
    require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
    const mongoose = require('mongoose');
    const connectDB = require('../config/database');
    await connectDB();
    try {
        const MerchantWebhookDelivery = require('../models/MerchantWebhookDelivery');
        const listing = await listStaleSendingWebhooks(MerchantWebhookDelivery);
        console.log(JSON.stringify(listing, null, 2));
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    listStaleSendingWebhooks
};
