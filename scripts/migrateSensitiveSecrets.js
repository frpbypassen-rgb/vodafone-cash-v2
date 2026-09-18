'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const ExecutorGroup = require('../models/ExecutorGroup');
const { encrypt, isEncrypted } = require('../utils/encryption');
const { hashApiKey, apiKeyHint, looksHashedApiKey } = require('../utils/apiKeyCrypto');
const { isEnabled, isProduction } = require('../utils/runtimeEnv');
const { extractDbName } = require('../utils/financialResetGuard');

const assertMigrationAllowed = (dbName) => {
    if (!process.env.ENCRYPTION_KEY) {
        throw new Error('ENCRYPTION_KEY is required before migrating recoverable secrets.');
    }
    if (isProduction() && !isEnabled(process.env.ALLOW_SECRET_MIGRATION)) {
        throw new Error('Refusing production migration without ALLOW_SECRET_MIGRATION=true.');
    }
    const expected = String(process.env.CONFIRM_DB_NAME || '').trim();
    if (!expected || expected !== dbName) {
        throw new Error(`CONFIRM_DB_NAME="${expected}" does not match connected database "${dbName}".`);
    }
};

const migrateProviderSecrets = async () => {
    const groups = await ExecutorGroup.find({
        $or: [
            { apiPassword: { $exists: true, $nin: [null, ''] } },
            { apiToken: { $exists: true, $nin: [null, ''] } }
        ]
    });
    let encrypted = 0;
    for (const group of groups) {
        let changed = false;
        if (group.apiPassword && !isEncrypted(group.apiPassword)) {
            group.apiPassword = encrypt(group.apiPassword);
            changed = true;
        }
        if (group.apiToken && !isEncrypted(group.apiToken)) {
            group.apiToken = encrypt(group.apiToken);
            changed = true;
        }
        if (changed) {
            await group.save();
            encrypted += 1;
        }
    }
    return encrypted;
};

const hashAndClear = async (docs, plaintextField, hashField, hintField) => {
    let hashed = 0;
    let skippedHashed = 0;
    for (const doc of docs) {
        const plaintext = String(doc[plaintextField] || '').trim();
        if (!plaintext) continue;
        if (looksHashedApiKey(plaintext) || looksHashedApiKey(doc[hashField])) {
            skippedHashed += 1;
            continue;
        }
        doc[hashField] = hashApiKey(plaintext);
        doc[hintField] = apiKeyHint(plaintext);
        doc[plaintextField] = undefined;
        await doc.save();
        hashed += 1;
    }
    return { hashed, skippedHashed };
};

async function main() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) throw new Error('MONGO_URI is required');
    await mongoose.connect(mongoUri);
    const dbName = mongoose.connection.name || extractDbName(mongoUri);
    assertMigrationAllowed(dbName);

    const dryRun = isEnabled(process.env.DRY_RUN);
    console.log(`Connected to "${dbName}". dryRun=${dryRun}`);
    if (dryRun) {
        const [companies, agents, tenants, groups] = await Promise.all([
            ClientCompany.countDocuments({ token: { $exists: true, $nin: [null, ''] } }),
            User.countDocuments({ apiToken: { $exists: true, $nin: [null, ''] } }),
            Tenant.countDocuments({ $or: [{ apiKey: { $exists: true, $nin: [null, ''] } }, { apiSecret: { $exists: true, $nin: [null, ''] } }] }),
            ExecutorGroup.countDocuments({ $or: [{ apiPassword: { $exists: true, $nin: [null, ''] } }, { apiToken: { $exists: true, $nin: [null, ''] } }] })
        ]);
        console.log(`Would inspect companies=${companies} agents=${agents} tenants=${tenants} executorGroups=${groups}`);
        console.log('Merchant API keys that still exist in plaintext MUST be rotated after hashing.');
        await mongoose.disconnect();
        return;
    }

    const companies = await ClientCompany.find({ token: { $exists: true, $nin: [null, ''] } }).select('+token +tokenHash');
    const agents = await User.find({ apiToken: { $exists: true, $nin: [null, ''] } }).select('+apiToken +apiTokenHash');
    const tenants = await Tenant.find({ $or: [{ apiKey: { $exists: true, $nin: [null, ''] } }, { apiSecret: { $exists: true, $nin: [null, ''] } }] })
        .select('+apiKey +apiSecret +apiKeyHash +apiSecretHash');

    const companyResult = await hashAndClear(companies, 'token', 'tokenHash', 'tokenHint');
    const agentResult = await hashAndClear(agents, 'apiToken', 'apiTokenHash', 'apiTokenHint');

    let tenantHashed = 0;
    for (const tenant of tenants) {
        let changed = false;
        if (tenant.apiKey && !tenant.apiKeyHash) {
            tenant.apiKeyHash = hashApiKey(tenant.apiKey);
            tenant.apiKey = undefined;
            changed = true;
        }
        if (tenant.apiSecret && !tenant.apiSecretHash) {
            tenant.apiSecretHash = hashApiKey(tenant.apiSecret);
            tenant.apiSecret = undefined;
            changed = true;
        }
        if (changed) {
            await tenant.save();
            tenantHashed += 1;
        }
    }

    const encryptedGroups = await migrateProviderSecrets();

    console.log('Migration complete.');
    console.log(`Hashed company merchant keys: ${companyResult.hashed}`);
    console.log(`Hashed agent merchant keys: ${agentResult.hashed}`);
    console.log(`Hashed tenant API credentials: ${tenantHashed}`);
    console.log(`Encrypted executor provider secrets: ${encryptedGroups}`);
    console.log('IMPORTANT: historically plaintext merchant keys must be rotated out of band. Hashed keys still work until rotation.');
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error.message || error);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
});
