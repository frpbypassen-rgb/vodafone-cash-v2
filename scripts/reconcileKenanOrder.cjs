'use strict';
// One saved reference only. Default is a read-only preview. Never starts workers
// or sends a provider POST. Can run from a reviewed checkout with live deps.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, Module } = require('node:module');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1] || ''; };
async function main() {
    const project = arg('--project'), operation = arg('--operation'), statePath = arg('--state');
    const apply = process.argv.includes('--apply');
    if (!project || !/^ATT-[A-Z0-9-]+$/i.test(operation) || !statePath) throw new Error('KENAN_ARGUMENTS_REQUIRED');
    const root = fs.realpathSync(project);
    const state = path.resolve(statePath);
    const relative = path.relative(root, state);
    if ((!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) || path.extname(state) !== '.json') throw new Error('KENAN_STATE_PATH_INVALID');
    const localRequire = createRequire(path.join(root, 'package.json'));
    process.env.NODE_PATH = path.join(root, 'node_modules'); Module._initPaths();
    const env = localRequire('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
    for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
    process.env.BULLMQ_WORKERS_ENABLED = 'false'; process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
    process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = 'false'; process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';
    process.chdir(root);
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => { const callback = args[args.length - 1]; if (typeof callback === 'function') callback(); return true; };
    const mongoose = localRequire('mongoose');
    mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
    const Transaction = require('../models/Transaction');
    const Ledger = require('../models/Ledger');
    const redis = require('../config/redis');
    try {
        await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
        const tx = await Transaction.findOne({ customId: operation });
        if (!tx?.executorGroupId || !tx.apiResultData?.kenanReference) throw new Error('KENAN_TRANSACTION_NOT_FOUND');
        const saved = apply ? JSON.parse(fs.readFileSync(state, 'utf8')) : null;
        if (apply && (saved.customId !== tx.customId || saved.reference !== tx.apiResultData.kenanReference
            || saved.amount !== Number(tx.amount) || saved.executorGroupId !== String(tx.executorGroupId))) throw new Error('KENAN_PREVIEW_CHANGED');
        if (apply) { await redis.initRedis(); if (!redis.isRedis()) throw new Error('KENAN_AUDIT_REDIS_REQUIRED'); }
        const { reconcileKenanOrder } = require('../services/kenanReconciliationService');
        const result = await reconcileKenanOrder({ transactionId: String(tx._id), executorGroupId: String(tx.executorGroupId),
            actor: { role: 'master', model: 'System', name: 'Authorized server operator' },
            confirm: apply, expectedUpdatedAt: saved?.expectedUpdatedAt });
        const output = { ...result, order: undefined, amount: Number(tx.amount), executorGroupId: String(tx.executorGroupId),
            providerPaymentCalls: 0, mode: apply ? 'apply' : 'preview' };
        if (apply) {
            const current = await Transaction.findById(tx._id);
            output.verification = { status: current.status, executorDebitCount: await Ledger.countDocuments({ transactionId: tx.customId,
                entityModel: 'ExecutorGroup', entityId: tx.executorGroupId, type: 'TRANSFER', amount: -Number(tx.amount) }),
                receiptPresent: Boolean(current.apiResultData?.executorReceiptProof) };
            if (output.verification.status !== 'completed' || output.verification.executorDebitCount !== 1) throw new Error('KENAN_POSTCHECK_FAILED');
        } else fs.writeFileSync(state, JSON.stringify(output, null, 2));
        write(JSON.stringify(output, null, 2) + '\n');
    } finally {
        const client = redis.getRedisClient(); if (typeof client?.disconnect === 'function') client.disconnect();
        await mongoose.disconnect(); process.stdout.write = write;
    }
}
if (require.main === module) main().catch(error => {
    console.error(/^KENAN_[A-Z_]+$/.test(error.message) ? error.message : 'KENAN_RECONCILIATION_FAILED');
    process.exitCode = 1;
});
module.exports = { main };
