'use strict';

/**
 * Read-only listing of API transfers whose provider Payment may have been
 * accepted without a definitive local result.
 *
 * This file calls countDocuments and find only. It does not update, delete,
 * refund, or contact the provider. Resolution is a business decision; this
 * script does not implement one.
 *
 * Usage: MONGO_URI="mongodb://..." node scripts/listUnresolvedProviderResults.js
 */

const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const { unresolvedProviderResultFilter } = require('../services/providerDispatchClaimService');

const listFromDatabase = async ({ limit = 200 } = {}) => {
    const filter = unresolvedProviderResultFilter();
    const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const count = await Transaction.countDocuments(filter);
    const rows = await Transaction.find(filter)
        .sort({ updatedAt: -1 })
        .limit(capped)
        .select('customId status amount executorGroupId executorName apiResultData createdAt updatedAt')
        .lean();
    return {
        count,
        returned: rows.length,
        rows: rows.map((row) => ({
            id: String(row._id),
            customId: row.customId,
            status: row.status,
            amount: row.amount,
            executorGroupId: row.executorGroupId ? String(row.executorGroupId) : null,
            executorName: row.executorName || '',
            providerResultUnresolved: Boolean(row.apiResultData && row.apiResultData.providerResultUnresolved),
            providerResultUnresolvedAt: row.apiResultData && row.apiResultData.providerResultUnresolvedAt || null,
            providerResultUnresolvedReason: row.apiResultData && row.apiResultData.providerResultUnresolvedReason || '',
            providerDispatchStartedAt: row.apiResultData && row.apiResultData.providerDispatchStartedAt || null,
            providerDispatchAttemptId: row.apiResultData && row.apiResultData.providerDispatchAttemptId || '',
            providerDispatchResult: row.apiResultData && row.apiResultData.providerDispatchResult || ''
        }))
    };
};

const main = async () => {
    const mongoUri = String(process.env.MONGO_URI || '').trim();
    if (!mongoUri) {
        console.error('[ERROR] MONGO_URI is required. This script does not read a production default.');
        process.exit(2);
    }
    await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
    });
    try {
        const listing = await listFromDatabase({ limit: 200 });
        console.log(JSON.stringify(listing, null, 2));
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error('[ERROR]', error.message);
        process.exit(1);
    });
}

module.exports = {
    listFromDatabase
};
