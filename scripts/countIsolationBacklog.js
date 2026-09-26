'use strict';

// Read-only counts. This script does not update, delete, or send anything.

const providerPaidAwaitingCompletionFilter = Object.freeze({
    status: 'processing',
    'apiResultData.waitingApiAutoCompletion': true
});

const countIsolationBacklog = async (db) => {
    const transactions = db.collection('transactions');
    const deliveries = db.collection('merchantwebhookdeliveries');
    const [
        providerPaidAwaitingCompletion,
        webhookPending,
        webhookFailed,
        webhookSending
    ] = await Promise.all([
        transactions.countDocuments(providerPaidAwaitingCompletionFilter),
        deliveries.countDocuments({ status: 'pending' }),
        deliveries.countDocuments({ status: 'failed' }),
        deliveries.countDocuments({ status: 'sending' })
    ]);
    return {
        readOnly: true,
        providerPaidAwaitingCompletion,
        webhookPending,
        webhookFailed,
        webhookSending
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
    countIsolationBacklog,
    providerPaidAwaitingCompletionFilter
};
