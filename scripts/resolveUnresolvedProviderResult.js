'use strict';

/**
 * Resolve ONE provider-unresolved transfer after a human has provider evidence.
 *
 * Dry-run is the default. Pass --confirm and the expectedUpdatedAt from that
 * preview to apply. This script never calls Payment and never opens a
 * production URI of its own.
 *
 * Usage:
 *   MONGO_URI="mongodb://..." node scripts/resolveUnresolvedProviderResult.js \
 *     --id <transaction id> \
 *     --outcome provider_paid|provider_not_paid \
 *     --evidence <provider TransactionNumber | statement line | ticket id> \
 *     --note "<why this evidence closes the row>" \
 *     --actor-id <admin id>
 *     [--confirm --expected-updated-at <ISO from the dry-run>]
 */

const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const { resolveProviderResult } = require('../services/providerResolutionService');

const readArg = (name) => {
    const index = process.argv.indexOf(name);
    if (index === -1) return '';
    return String(process.argv[index + 1] || '').trim();
};

const main = async () => {
    const mongoUri = String(process.env.MONGO_URI || '').trim();
    if (!mongoUri) {
        console.error('[ERROR] MONGO_URI is required. This script does not read a production default.');
        process.exit(2);
    }

    const transactionId = readArg('--id');
    const outcome = readArg('--outcome');
    const evidenceReference = readArg('--evidence');
    const note = readArg('--note');
    const actorId = readArg('--actor-id');
    const expectedUpdatedAt = readArg('--expected-updated-at');
    const confirm = process.argv.includes('--confirm');

    if (!transactionId || !outcome || !evidenceReference || !note || !actorId) {
        console.error('[ERROR] --id, --outcome, --evidence, --note, and --actor-id are required.');
        process.exit(2);
    }
    if (confirm && !expectedUpdatedAt) {
        console.error('[ERROR] --confirm requires --expected-updated-at from the dry-run preview.');
        process.exit(2);
    }

    await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
    });
    try {
        const admin = await Admin.findById(actorId);
        if (!admin || admin.status !== 'active') {
            console.error('[ERROR] Active admin actor was not found.');
            process.exit(3);
        }
        const result = await resolveProviderResult({
            transactionId,
            outcome,
            evidenceReference,
            note,
            confirm,
            expectedUpdatedAt: expectedUpdatedAt || undefined,
            actor: {
                id: admin._id,
                name: admin.name,
                role: admin.role,
                permissions: admin.permissions || []
            }
        });
        console.log(JSON.stringify(result, null, 2));
        if (!result.success) process.exitCode = 1;
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

module.exports = { main };
