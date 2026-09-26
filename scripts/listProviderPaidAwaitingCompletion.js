'use strict';

// Read-only listing. This script does not update Ledger, Transaction, or AuditLog rows
// and does not call a provider.

const PROJECTION = Object.freeze({
    customId: 1,
    status: 1,
    amount: 1,
    executorGroupId: 1,
    executorName: 1,
    'apiResultData.waitingApiAutoCompletion': 1,
    'apiResultData.referenceNumber': 1,
    'apiResultData.externalTransactionId': 1,
    'apiResultData.providerTransactionId': 1,
    'apiResultData.autoCompleteAt': 1,
    'apiResultData.ledgerPosted': 1
});

const listProviderPaidAwaitingCompletion = (model) => {
    const {
        PROVIDER_PAID_AWAITING_COMPLETION_FILTER
    } = require('../services/apiExecutionLifecycleService');
    return model.find(PROVIDER_PAID_AWAITING_COMPLETION_FILTER).select(PROJECTION).lean();
};

const main = async () => {
    require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
    const mongoose = require('mongoose');
    const connectDB = require('../config/database');
    const Transaction = require('../models/Transaction');
    await connectDB();
    try {
        const rows = await listProviderPaidAwaitingCompletion(Transaction);
        console.log(JSON.stringify({
            readOnly: true,
            count: rows.length,
            rows
        }, null, 2));
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
    PROJECTION,
    listProviderPaidAwaitingCompletion
};
