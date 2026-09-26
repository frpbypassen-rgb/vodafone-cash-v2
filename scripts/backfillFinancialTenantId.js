'use strict';

/**
 * Backfill tenantId on historical financial records.
 *
 * Dry-run is the default. Nothing is written unless --apply is present.
 * Ambiguous rows are never guessed. Balances, amounts, and statuses are never modified.
 *
 * Operator command (staging restored from a recent production backup):
 *   node scripts/backfillFinancialTenantId.js
 * Apply only after reviewing the dry-run report:
 *   node scripts/backfillFinancialTenantId.js --apply --checkpoint .\tenant-backfill-checkpoint.json
 *
 * Do NOT use scripts/migrateTenantIsolation.js for this. That script assigns every
 * tenantless row to the default tenant, including ambiguous ones.
 */

const fs = require('fs');

const BATCH_SIZE = 100;
const tenantlessFilter = {
    $or: [
        { tenantId: { $exists: false } },
        { tenantId: null }
    ]
};

const idString = (value) => (value === null || value === undefined || value === '' ? null : String(value));

const sameTenant = (left, right) => {
    const a = idString(left);
    const b = idString(right);
    return Boolean(a && b && a === b);
};

const decide = (candidates) => {
    const present = candidates.filter((item) => item && item.tenantId);
    if (!present.length) return { state: 'unresolvable', tenantId: null, reason: 'no-linked-tenant' };
    const distinct = [...new Set(present.map((item) => idString(item.tenantId)))];
    if (distinct.length > 1) {
        return { state: 'ambiguous', tenantId: null, reason: present.map((item) => item.source).join('+') };
    }
    return { state: 'confident', tenantId: present[0].tenantId, reason: present.map((item) => item.source).join('+') };
};

const classifyTransaction = (tx, lookup) => {
    if (tx.tenantId) return { state: 'already', tenantId: tx.tenantId, reason: 'present' };
    const company = tx.companyId ? lookup.companies.get(idString(tx.companyId)) : null;
    const sub = tx.subAccountId ? lookup.subAccounts.get(idString(tx.subAccountId)) : null;
    const users = tx.userId ? (lookup.usersByKey.get(String(tx.userId)) || []) : [];
    const userTenants = [...new Set(users.map((user) => idString(user.tenantId)).filter(Boolean))];
    const candidates = [];
    if (company && company.tenantId) candidates.push({ source: 'company', tenantId: company.tenantId });
    if (sub && sub.tenantId) candidates.push({ source: 'subAccount', tenantId: sub.tenantId });
    if (userTenants.length === 1) candidates.push({ source: 'user', tenantId: users.find((user) => user.tenantId).tenantId });
    if (userTenants.length > 1) return { state: 'ambiguous', tenantId: null, reason: 'user-key-multiple-tenants' };
    return decide(candidates);
};

const classifyLedger = (entry, lookup) => {
    if (entry.tenantId) return { state: 'already', tenantId: entry.tenantId, reason: 'present' };
    const tx = lookup.transactions.get(String(entry.transactionId || ''));
    const entity = lookup.entity(entry.entityModel, entry.entityId);
    const txClass = tx ? classifyTransaction(tx, lookup) : null;
    const candidates = [];
    if (txClass && txClass.state === 'already') candidates.push({ source: 'transaction', tenantId: txClass.tenantId });
    if (txClass && txClass.state === 'confident') candidates.push({ source: 'transaction', tenantId: txClass.tenantId });
    if (txClass && txClass.state === 'ambiguous') return { state: 'ambiguous', tenantId: null, reason: 'transaction-ambiguous' };
    if (entity && entity.tenantId) candidates.push({ source: 'entity', tenantId: entity.tenantId });
    return decide(candidates);
};

const classifyJournal = (event, lookup) => {
    if (event.tenantId) return { state: 'already', tenantId: event.tenantId, reason: 'present' };
    const txId = event.metadata && event.metadata.transactionId;
    const tx = txId ? lookup.transactions.get(String(txId)) : null;
    const entity = lookup.entity(event.entityModel, event.entityId);
    const txClass = tx ? classifyTransaction(tx, lookup) : null;
    const candidates = [];
    if (txClass && (txClass.state === 'already' || txClass.state === 'confident')) {
        candidates.push({ source: 'transaction', tenantId: txClass.tenantId });
    }
    if (txClass && txClass.state === 'ambiguous') return { state: 'ambiguous', tenantId: null, reason: 'transaction-ambiguous' };
    if (entity && entity.tenantId) candidates.push({ source: 'entity', tenantId: entity.tenantId });
    return decide(candidates);
};

const classifyAudit = (entry, lookup) => {
    if (entry.tenantId) return { state: 'already', tenantId: entry.tenantId, reason: 'present' };
    const company = entry.companyId ? lookup.companies.get(idString(entry.companyId)) : null;
    const actor = lookup.actor(entry.performedByModel, entry.performedBy);
    const candidates = [];
    if (company && company.tenantId) candidates.push({ source: 'company', tenantId: company.tenantId });
    if (actor && actor.tenantId) candidates.push({ source: 'actor', tenantId: actor.tenantId });
    return decide(candidates);
};

const buildLookup = ({ companies, users, subAccounts, transactions }) => {
    const companyMap = new Map(companies.map((doc) => [idString(doc._id), doc]));
    const subMap = new Map(subAccounts.map((doc) => [idString(doc._id), doc]));
    const userMap = new Map(users.map((doc) => [idString(doc._id), doc]));
    const usersByKey = new Map();
    for (const user of users) {
        for (const key of [user.phone, user.webUsername, user.telegramId, user.accountCode].filter(Boolean)) {
            const bucket = usersByKey.get(String(key)) || [];
            bucket.push(user);
            usersByKey.set(String(key), bucket);
        }
    }
    const txMap = new Map();
    for (const tx of transactions) {
        if (tx.customId) txMap.set(String(tx.customId), tx);
        if (tx._id) txMap.set(idString(tx._id), tx);
    }
    const entity = (model, id) => {
        const key = idString(id);
        if (!key) return null;
        if (model === 'User') return userMap.get(key) || null;
        if (model === 'ClientCompany') return companyMap.get(key) || null;
        if (model === 'SubAccount') return subMap.get(key) || null;
        return null;
    };
    const actor = (model, id) => entity(model, id);
    return { companies: companyMap, subAccounts: subMap, usersByKey, transactions: txMap, entity, actor };
};

const emptyBucket = () => ({ confident: 0, ambiguous: 0, unresolvable: 0, already: 0, modified: 0 });

const classifyCollection = (docs, classify) => {
    const bucket = emptyBucket();
    const samples = { ambiguous: [], unresolvable: [] };
    const updates = [];
    for (const doc of docs) {
        const result = classify(doc);
        bucket[result.state] += 1;
        if (result.state === 'confident') updates.push({ _id: doc._id, tenantId: result.tenantId });
        if ((result.state === 'ambiguous' || result.state === 'unresolvable') && samples[result.state].length < 20) {
            samples[result.state].push({ _id: idString(doc._id), reason: result.reason });
        }
    }
    return { bucket, samples, updates };
};

const loadBatch = async (Model, afterId) => {
    const filter = afterId ? { ...tenantlessFilter, _id: { $gt: afterId } } : tenantlessFilter;
    return Model.find(filter).sort({ _id: 1 }).limit(BATCH_SIZE).lean();
};

const applyUpdates = async (Model, updates) => {
    let modified = 0;
    for (const update of updates) {
        const result = await Model.collection.updateOne(
            {
                _id: update._id,
                $or: [{ tenantId: { $exists: false } }, { tenantId: null }]
            },
            { $set: { tenantId: update.tenantId } }
        );
        modified += result.modifiedCount || 0;
    }
    return modified;
};

const scanModel = async (Model, classify, { apply, checkpoint, name }) => {
    const summary = emptyBucket();
    const samples = { ambiguous: [], unresolvable: [] };
    let afterId = checkpoint && checkpoint[name] ? checkpoint[name] : null;
    let batches = 0;
    for (;;) {
        const docs = await loadBatch(Model, afterId);
        if (!docs.length) break;
        batches += 1;
        const classified = classifyCollection(docs, classify);
        for (const key of Object.keys(summary)) {
            if (key === 'modified') continue;
            summary[key] += classified.bucket[key];
        }
        for (const kind of ['ambiguous', 'unresolvable']) {
            for (const sample of classified.samples[kind]) {
                if (samples[kind].length < 20) samples[kind].push(sample);
            }
        }
        if (apply && classified.updates.length) {
            summary.modified += await applyUpdates(Model, classified.updates);
        }
        afterId = docs[docs.length - 1]._id;
        if (checkpoint) checkpoint[name] = idString(afterId);
        if (docs.length < BATCH_SIZE) break;
    }
    summary.batches = batches;
    return { summary, samples };
};

const readCheckpoint = (file) => {
    if (!file || !fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const writeCheckpoint = (file, checkpoint) => {
    if (!file) return;
    fs.writeFileSync(file, JSON.stringify(checkpoint, null, 2));
};

const runBackfill = async ({
    apply = false,
    checkpointFile = null,
    User,
    ClientCompany,
    SubAccount,
    Transaction,
    Ledger,
    JournalEvent,
    AuditLog
}) => {
    const [companies, users, subAccounts, transactions] = await Promise.all([
        ClientCompany.find({}).select('_id tenantId').lean(),
        User.find({}).select('_id tenantId phone webUsername telegramId accountCode').lean(),
        SubAccount.find({}).select('_id tenantId').lean(),
        Transaction.find({}).select('_id customId tenantId companyId subAccountId userId amount status balance').lean()
    ]);
    const lookup = buildLookup({ companies, users, subAccounts, transactions });
    const checkpoint = apply ? readCheckpoint(checkpointFile) : {};
    const startedAt = new Date().toISOString();

    const transactionResult = await scanModel(
        Transaction,
        (doc) => classifyTransaction(doc, lookup),
        { apply, checkpoint, name: 'Transaction' }
    );
    const ledgerResult = await scanModel(
        Ledger,
        (doc) => classifyLedger(doc, lookup),
        { apply, checkpoint, name: 'Ledger' }
    );
    const journalResult = await scanModel(
        JournalEvent,
        (doc) => classifyJournal(doc, lookup),
        { apply, checkpoint, name: 'JournalEvent' }
    );
    const auditResult = await scanModel(
        AuditLog,
        (doc) => classifyAudit(doc, lookup),
        { apply, checkpoint, name: 'AuditLog' }
    );

    if (apply) writeCheckpoint(checkpointFile, checkpoint);

    return {
        mode: apply ? 'apply' : 'dry-run',
        startedAt,
        finishedAt: new Date().toISOString(),
        note: 'Dry-run does not write. Ambiguous rows are never updated. Balances, amounts, and statuses are not fields this script sets.',
        unchangedFields: ['balance', 'amount', 'status'],
        collections: {
            Transaction: transactionResult,
            Ledger: ledgerResult,
            JournalEvent: journalResult,
            AuditLog: auditResult
        }
    };
};

const parseArgs = (argv) => ({
    apply: argv.includes('--apply'),
    checkpointFile: (() => {
        const index = argv.indexOf('--checkpoint');
        return index >= 0 ? argv[index + 1] : null;
    })()
});

const main = async () => {
    require('dotenv').config();
    const mongoose = require('mongoose');
    const args = parseArgs(process.argv.slice(2));
    const mongoUri = String(process.env.MONGO_URI || '').trim();
    if (!mongoUri || mongoUri.toLowerCase() === 'demo') {
        throw new Error('MONGO_URI must point at the staging database restored from a recent production backup.');
    }
    await mongoose.connect(mongoUri);
    const report = await runBackfill({
        apply: args.apply,
        checkpointFile: args.checkpointFile,
        User: require('../models/User'),
        ClientCompany: require('../models/ClientCompany'),
        SubAccount: require('../models/SubAccount'),
        Transaction: require('../models/Transaction'),
        Ledger: require('../models/Ledger'),
        JournalEvent: require('../models/JournalEvent'),
        AuditLog: require('../models/AuditLog')
    });
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
};

if (require.main === module) {
    main().catch((error) => {
        console.error(`Financial tenant backfill failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    classifyTransaction,
    classifyLedger,
    classifyJournal,
    classifyAudit,
    buildLookup,
    runBackfill,
    tenantlessFilter,
    BATCH_SIZE,
    sameTenant
};
