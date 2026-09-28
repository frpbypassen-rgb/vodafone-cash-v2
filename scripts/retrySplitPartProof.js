'use strict';

/**
 * Retries the customer proof for one split part.
 * It does not complete, re-execute, or post any financial movement.
 *
 * Usage: node scripts/retrySplitPartProof.js <transactionId> <partId>
 */
require('dotenv').config();

const mongoose = require('mongoose');
const { retrySplitPartProof } = require('../services/splitPartProofService');

const transactionId = process.argv[2];
const partId = process.argv[3];

const main = async () => {
    if (!transactionId || !partId) {
        console.error('Usage: node scripts/retrySplitPartProof.js <transactionId> <partId>');
        process.exitCode = 1;
        return;
    }
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('Database URI is not configured.');
        process.exitCode = 1;
        return;
    }

    await mongoose.connect(uri);
    try {
        const result = await retrySplitPartProof(transactionId, partId);
        console.log(JSON.stringify({
            ok: Boolean(result.ok),
            code: result.code || null,
            partId: result.partId || partId,
            proofStatus: result.proofStatus || null,
            duplicate: Boolean(result.duplicate)
        }));
        if (!result.ok) process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
};

main().catch((error) => {
    const message = /bearer|token|secret|authorization/i.test(String(error.message || ''))
        ? 'Retry failed.'
        : (error.message || 'Retry failed.');
    console.error(message);
    process.exitCode = 1;
    mongoose.disconnect().catch(() => {});
});
