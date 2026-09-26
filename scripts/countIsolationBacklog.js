'use strict';

// Read-only counts. This script does not update, delete, or send anything.

const providerPaidAwaitingCompletionFilter = Object.freeze({
    status: 'processing',
    'apiResultData.waitingApiAutoCompletion': true
});

// Same 2-minute lease as LOCK_TIMEOUT_MS in services/merchantWebhookService.js.
const WEBHOOK_SENDING_STALE_MS = 2 * 60 * 1000;

const countIsolationBacklog = async (db, now = new Date()) => {
    const transactions = db.collection('transactions');
    const deliveries = db.collection('merchantwebhookdeliveries');
    const staleBefore = new Date(now.getTime() - WEBHOOK_SENDING_STALE_MS);
    const [
        providerPaidAwaitingCompletion,
        webhookPending,
        webhookFailed,
        webhookSending,
        webhookSendingStale
    ] = await Promise.all([
        transactions.countDocuments(providerPaidAwaitingCompletionFilter),
        deliveries.countDocuments({ status: 'pending' }),
        deliveries.countDocuments({ status: 'failed' }),
        deliveries.countDocuments({ status: 'sending' }),
        deliveries.countDocuments({ status: 'sending', lockedAt: { $lte: staleBefore } })
    ]);
    return {
        readOnly: true,
        providerPaidAwaitingCompletion,
        webhookPending,
        webhookFailed,
        webhookSending,
        webhookSendingStale
    };
};

const main = async () => {
    require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
    const mongoose = require('mongoose');
    const connectDB = require('../config/database');
    await connectDB();
    try {
        const counts = await countIsolationBacklog(mongoose.connection.db);
        console.log(JSON.stringify(counts, null, 2));
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
    WEBHOOK_SENDING_STALE_MS,
    countIsolationBacklog,
    providerPaidAwaitingCompletionFilter
};
