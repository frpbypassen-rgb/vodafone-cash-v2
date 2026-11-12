'use strict';

// One recorded paid decision only. Default is read-only; never starts workers.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, Module } = require('node:module');
const readArg = name => {
    const index = process.argv.indexOf(name);
    return index < 0 ? '' : String(process.argv[index + 1] || '').trim();
};

async function main() {
    const project = readArg('--project');
    const operation = readArg('--operation');
    const apply = process.argv.includes('--apply');
    const expectedUpdatedAt = readArg('--expected-updated-at');
    if (!project || !/^ATT-[A-Z0-9-]+$/i.test(operation) || (apply && !expectedUpdatedAt)) {
        throw new Error('PROJECT_OPERATION_AND_APPLY_VERSION_REQUIRED');
    }
    const root = fs.realpathSync(project);
    const localRequire = createRequire(path.join(root, 'package.json'));
    // A reviewed worktree can borrow installed dependencies without changing live source.
    process.env.NODE_PATH = path.join(root, 'node_modules');
    Module._initPaths();
    const env = localRequire('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
    for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
    process.env.EXTERNAL_API_ENABLED = 'false';
    process.env.BULLMQ_WORKERS_ENABLED = 'false';
    process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
    process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = 'false';
    process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';
    process.chdir(root);
    // Library logs must not corrupt the JSON consumed by PowerShell. Never
    // expose their raw payloads; the verified result below remains authoritative.
    const writeResult = process.stdout.write.bind(process.stdout);
    let diagnosticWrites = 0;
    process.stdout.write = (...args) => {
        diagnosticWrites++;
        const callback = args[args.length - 1];
        if (typeof callback === 'function') callback();
        return true;
    };
    const mongoose = localRequire('mongoose');
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    const Transaction = require('../models/Transaction');
    const Admin = require('../models/Admin');
    const { resolveProviderResult } = require('../services/providerResolutionService');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI_MISSING');
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000,
        autoIndex: false, autoCreate: false });
    const redis = require('../config/redis');
    const needsRedis = apply && require('../config/runtimeScale').distributedStateRequired();
    try {
        // A maintenance process does not run app.js bootstrap. Production audit
        // locks still require a real initialized Redis client before any writes.
        if (needsRedis) {
            await redis.initRedis();
            if (!redis.isRedis()) throw new Error('RECOVERY_REDIS_NOT_READY');
        }
        const tx = await Transaction.findOne({ customId: operation });
        if (!tx) throw new Error('OPERATION_NOT_FOUND');
        const data = tx.apiResultData || {};
        const actorId = String(data.providerResolutionActorId || '');
        if (!mongoose.isValidObjectId(actorId)) throw new Error('RECORDED_ADMIN_MISSING');
        const actor = await Admin.findById(actorId);
        if (!actor || actor.status !== 'active') throw new Error('RECORDED_ADMIN_NOT_ACTIVE');
        const result = await resolveProviderResult({ transactionId: String(tx._id),
            outcome: 'provider_paid', evidenceReference: data.providerResolutionEvidence,
            note: data.providerResolutionNote, resumePaid: true,
            enableApiCredit: process.argv.includes('--enable-api-credit'),
            confirm: apply, expectedUpdatedAt: expectedUpdatedAt || undefined,
            actor: { id: actor._id, name: actor.name, role: actor.role, permissions: actor.permissions || [] }
        });
        const stored = await Transaction.findById(tx._id);
        const Ledger = require('../models/Ledger');
        const ExecutorGroup = require('../models/ExecutorGroup');
        const group = await ExecutorGroup.findById(stored.executorGroupId);
        result.verification = { status: stored.status, updatedAt: stored.updatedAt,
            providerResultUnresolved: stored.apiResultData?.providerResultUnresolved === true,
            executorDebitCount: await Ledger.countDocuments({ transactionId: stored.customId,
                entityModel: 'ExecutorGroup', type: 'TRANSFER', amount: { $lt: 0 } }),
            executorBalance: group?.balance ?? null, apiSettlementMode: group?.apiSettlementMode || 'prepaid',
            systemReceiptPresent: Boolean(stored.apiResultData?.executorReceiptProof),
            auditRedis: needsRedis ? 'connected' : 'not_requested' };
        result.diagnosticWrites = diagnosticWrites;
        writeResult(JSON.stringify(result, null, 2) + '\n');
        if (!result.success || (apply && (result.verification.status !== 'completed'
            || result.verification.providerResultUnresolved || result.verification.executorDebitCount !== 1))) process.exitCode = 1;
    } finally {
        if (needsRedis) {
            const client = redis.getRedisClient();
            if (typeof client.disconnect === 'function') client.disconnect();
        }
        await mongoose.disconnect();
    }
}

if (require.main === module) main().catch(() => {
    // Do not print URLs, environment values, raw driver errors, or credentials.
    console.error('RECORDED_API_PAYMENT_RECOVERY_FAILED. No provider Payment is sent; inspect the operation before retrying.');
    process.exitCode = 1;
});
module.exports = { main };
