'use strict';

require('./productionEnv').applyProductionEnv();
const httpMock = require('./httpMock');
httpMock.install();

global.__rcCrashCustomId = null;
global.__rcWriteConflictCustomId = null;
global.__rcWriteConflictAttempts = 0;
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function requireWithCrashHook(id) {
    const exported = originalRequire.apply(this, arguments);
    if (exported && typeof exported.updateBalanceWithLedger === 'function' && !exported.__rcCrashWrapped) {
        const original = exported.updateBalanceWithLedger;
        exported.updateBalanceWithLedger = async function crashAwareBalanceUpdate(...args) {
            const result = await original.apply(this, args);
            if (global.__rcCrashCustomId && args[4] === global.__rcCrashCustomId) {
                global.__rcCrashCustomId = null;
                throw new Error('crash between debit and save');
            }
            if (global.__rcWriteConflictCustomId && args[4] === global.__rcWriteConflictCustomId) {
                global.__rcWriteConflictAttempts = (global.__rcWriteConflictAttempts || 0) + 1;
                global.__rcWriteConflictCustomId = null;
                const error = new Error('WriteConflict');
                error.code = 112;
                error.errorLabels = ['TransientTransactionError'];
                throw error;
            }
            return result;
        };
        exported.__rcCrashWrapped = true;
    }
    return exported;
};

require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'CommonJS' }
});

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const { seed } = require('./seed');
const { takeSnapshot } = require('./snapshot');

const profile = process.env.RC_PROFILE || 'rc';
const targetRoot = path.resolve(process.env.RC_TARGET || process.cwd());
const load = (relativePath) => require(path.join(targetRoot, relativePath));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(Number(value || 0) * 100) / 100;

const results = {};

const record = async (name, fn) => {
    try {
        results[name] = { ok: true, ...(await fn()) };
    } catch (error) {
        results[name] = { ok: false, error: error.stack || error.message };
    }
};

const clientSession = (clientId, accountType) => ({
    isClientLoggedIn: true,
    clientId: String(clientId),
    accountType,
    clientSessionVersion: 0,
    clientName: 'مراجعة',
    destroy(callback) { if (callback) callback(); }
});

const adminSession = (ids) => ({
    isLoggedIn: true,
    adminId: String(ids.admin),
    adminName: 'RC Review Admin',
    adminRole: 'master',
    csrfToken: 'csrf-review-token',
    destroy(callback) { if (callback) callback(); }
});

const executorSession = (ids) => ({
    isExecutorLoggedIn: true,
    executorId: String(ids.humanEmployee),
    destroy(callback) { if (callback) callback(); }
});

const balances = async (models, ids) => {
    const [client, company, agent, sub, human, api] = await Promise.all([
        models.User.findById(ids.client).select('balance').lean(),
        models.ClientCompany.findById(ids.company).select('balance').lean(),
        models.User.findById(ids.agent).select('balance').lean(),
        models.SubAccount.findById(ids.sub).select('balance').lean(),
        models.ExecutorGroup.findById(ids.humanGroup).select('balance').lean(),
        models.ExecutorGroup.findById(ids.apiGroup).select('balance').lean()
    ]);
    return {
        client: client && client.balance,
        company: company && company.balance,
        agent: agent && agent.balance,
        sub: sub && sub.balance,
        humanExecutor: human && human.balance,
        apiExecutor: api && api.balance
    };
};

const ledgerSummary = async (models, customId) => {
    const rows = await models.Ledger.find(customId ? { transactionId: customId } : {})
        .select('entityModel type amount description')
        .lean();
    const byType = {};
    rows.forEach((row) => {
        const key = `${row.entityModel || ''}:${row.type || ''}`;
        if (!byType[key]) byType[key] = { count: 0, amount: 0 };
        byType[key].count += 1;
        byType[key].amount = round(byType[key].amount + Number(row.amount || 0));
    });
    return { count: rows.length, byType };
};

const txView = async (models, customId) => {
    const tx = await models.Transaction.findOne({ customId }).lean();
    if (!tx) return null;
    return {
        status: tx.status,
        amount: tx.amount,
        waiting: Boolean(tx.apiResultData && tx.apiResultData.waitingApiAutoCompletion),
        claimed: Boolean(tx.apiResultData && tx.apiResultData.completionClaimedAt),
        executorGroupId: tx.executorGroupId ? String(tx.executorGroupId) : null,
        partProofs: (tx.executorSenderEntries || []).map((entry) => ({
            partId: entry.partId || null,
            status: entry.status || null,
            proofStatus: entry.customerProof && entry.customerProof.status || null,
            lastError: entry.customerProof && entry.customerProof.lastError || null
        }))
    };
};

const financialFingerprint = async (models) => {
    const snapshot = await takeSnapshot(models);
    return JSON.stringify(snapshot.financial);
};

const createTransfer = async (ctx, { amount, phone }) => {
    ctx.holder.session = clientSession(ctx.ids.client, 'client');
    const res = await request(ctx.app)
        .post('/client/transfer')
        .set('Accept', 'application/json')
        .send({ amount, type: 'كاش', phone, name: 'مستلم مراجعة' });
    if (res.status >= 400 || !res.body || !res.body.customId) {
        throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body;
};

const assignAndAccept = async (ctx, customId) => {
    const tx = await ctx.models.Transaction.findOne({ customId });
    ctx.holder.session = adminSession(ctx.ids);
    const assigned = await request(ctx.app)
        .post(`/transaction/${tx._id}/assign-executor`)
        .set('Accept', 'application/json')
        .send({ executorGroupId: String(ctx.ids.humanGroup) });
    if (assigned.status >= 400) throw new Error(`assign failed ${assigned.status} ${JSON.stringify(assigned.body)}`);
    ctx.holder.session = executorSession(ctx.ids);
    const accepted = await request(ctx.app)
        .post(`/executor-portal/api/accept-task/${tx._id}`)
        .set('Accept', 'application/json')
        .send({});
    if (accepted.status >= 400 || (accepted.body && accepted.body.success === false)) {
        throw new Error(`accept failed ${accepted.status} ${JSON.stringify(accepted.body)}`);
    }
    return tx._id;
};

const completeBody = (executionNumber, senderEntries) => ({
    executionNumber,
    senderEntries: senderEntries || [{ phone: executionNumber, amount: undefined }]
});

const prepareDelayed = async (ctx, { amount, phone, reference }) => {
    const created = await createTransfer(ctx, { amount, phone });
    const tx = await ctx.models.Transaction.findOne({ customId: created.customId });
    const group = await ctx.models.ExecutorGroup.findById(ctx.ids.apiGroup);
    const lifecycle = load('services/apiExecutionLifecycleService');
    const prepared = lifecycle.prepareApiTransactionForDelayedCompletion({
        tx,
        executorGroup: group,
        apiResult: {
            success: true,
            reference_number: reference,
            external_transaction_id: `${reference}-PROV`,
            sender_number: reference
        },
        receiptProof: null,
        detailedLog: 'rc-review delayed fixture'
    });
    if (!prepared) throw new Error('prepare delayed returned null');
    tx.apiResultData.autoCompleteAt = new Date(Date.now() - 1000);
    await tx.save();
    return created.customId;
};

const installDnsStub = () => {
    const original = dns.promises.lookup;
    dns.promises.lookup = async (hostname, options) => {
        if (String(hostname).includes('rc-review.example')) {
            if (options && options.all) return [{ address: '1.1.1.1', family: 4 }];
            return { address: '1.1.1.1', family: 4 };
        }
        return original(hostname, options);
    };
    return () => { dns.promises.lookup = original; };
};

const main = async () => {
    const mongoUri = process.env.RC_MONGO_URI;
    if (!mongoUri) throw new Error('RC_MONGO_URI is required');
    const Redis = require('ioredis');
    const flusher = new Redis(process.env.REDIS_URL || process.env.RC_REDIS_URL);
    await flusher.flushdb();
    await flusher.quit();

    mongoose.set('autoIndex', false);
    await mongoose.connect(mongoUri);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const buildInfo = await mongoose.connection.db.admin().command({ buildInfo: 1 });
    await mongoose.connection.dropDatabase();

    const redisApi = load('config/redis');
    await redisApi.initRedis();

    const models = {
        Admin: load('models/Admin'),
        User: load('models/User'),
        ClientCompany: load('models/ClientCompany'),
        ClientEmployee: load('models/ClientEmployee'),
        AgentEmployee: load('models/AgentEmployee'),
        SubAccount: load('models/SubAccount'),
        ExecutorGroup: load('models/ExecutorGroup'),
        Employee: load('models/Employee'),
        Settings: load('models/Settings'),
        Transaction: load('models/Transaction'),
        Ledger: load('models/Ledger'),
        AuditLog: load('models/AuditLog'),
        AgencyJournal: load('models/AgencyJournal'),
        Notification: load('models/Notification')
    };
    const ids = await seed(models);
    await models.Employee.updateOne({ _id: ids.humanEmployee }, { $set: { tenantId: new mongoose.Types.ObjectId('64a0000000000000000000aa') } });
    const tenantId = new mongoose.Types.ObjectId('64a0000000000000000000aa');
    const Tenant = load('models/Tenant');
    await Tenant.create({
        _id: tenantId,
        name: 'RC Review Tenant',
        slug: 'ahram-rc-review',
        status: 'active'
    });
    const holder = { session: {} };
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use((req, _res, next) => {
        req.tenant = { _id: tenantId, slug: 'ahram-rc-review', status: 'active' };
        req.session = holder.session;
        if (req.session && typeof req.session.destroy !== 'function') {
            req.session.destroy = (callback) => { if (callback) callback(); };
        }
        next();
    });
    app.use('/client', load('routes/clientPortal'));
    app.use('/executor-portal', load('routes/executorPortal'));
    app.use('/api/v1/merchant', load('routes/merchantApi'));
    app.use('/api/mobile', load('routes/mobileApi'));
    app.use('/', load('routes/adminTransactions'));
    app.use('/', load('routes/clients'));
    app.use('/', load('routes/executors'));
    const ctx = { app, holder, ids, models, load };

    const security = load('services/securityControlService');
    const SecurityDevice = load('models/SecurityDevice');
    await SecurityDevice.create({
        principalType: 'executor',
        principalId: String(ids.humanEmployee),
        channel: 'app',
        status: 'active',
        deviceIdHash: security.hashDeviceId('rc-review-device'),
        displayName: 'rc-review'
    });
    const mobileToken = jwt.sign({
        userId: String(ids.humanEmployee),
        accountType: 'executor',
        executorGroupId: String(ids.humanGroup),
        sessionVersion: 0,
        tenantId: String(tenantId),
        absoluteSessionExpiresAt: Date.now() + (60 * 60 * 1000)
    }, process.env.JWT_SECRET, { expiresIn: '1h' });

    await record('duplicate_concurrent_transfers', async () => {
        const before = await balances(models, ids);
        const paymentsBefore = httpMock.snapshotCounters().providerPayment;
        ctx.holder.session = clientSession(ids.client, 'client');
        const pair = await Promise.all([0, 1].map(() => request(app)
            .post('/client/transfer')
            .set('Accept', 'application/json')
            .send({ amount: 111, type: 'كاش', phone: '01055551101', name: 'مستلم مراجعة' })));
        const after = await balances(models, ids);
        const idsCreated = pair.map((res) => res.body && res.body.customId).filter(Boolean);
        const ledgers = await Promise.all(idsCreated.map((customId) => ledgerSummary(models, customId)));
        return {
            statuses: pair.map((res) => res.status),
            customIds: idsCreated,
            distinct: new Set(idsCreated).size,
            clientBefore: before.client,
            clientAfter: after.client,
            clientDelta: round(after.client - before.client),
            ledgerCounts: ledgers.map((row) => row.count),
            providerPayments: httpMock.snapshotCounters().providerPayment - paymentsBefore
        };
    });

    await record('concurrent_web_completion', async () => {
        const created = await createTransfer(ctx, { amount: 121, phone: '01055551102' });
        const txId = await assignAndAccept(ctx, created.customId);
        const before = await balances(models, ids);
        const ledgerBefore = await ledgerSummary(models, created.customId);
        ctx.holder.session = executorSession(ids);
        const responses = await Promise.all([0, 1].map(() => request(app)
            .post(`/executor-portal/api/complete-task/${txId}`)
            .set('Accept', 'application/json')
            .send({ executionNumber: '01055551902', senderEntries: [{ phone: '01055551902', amount: 121 }] })));
        await sleep(300);
        const after = await balances(models, ids);
        return {
            customId: created.customId,
            statuses: responses.map((res) => res.status),
            successes: responses.filter((res) => res.body && res.body.success !== false && res.status < 400).length,
            tx: await txView(models, created.customId),
            humanDelta: round(after.humanExecutor - before.humanExecutor),
            clientDelta: round(after.client - before.client),
            ledgerBefore: ledgerBefore.count,
            ledgerAfter: (await ledgerSummary(models, created.customId)).count,
            providerPayments: 0
        };
    });

    await record('concurrent_web_and_mobile_completion', async () => {
        const created = await createTransfer(ctx, { amount: 131, phone: '01055551103' });
        const txId = await assignAndAccept(ctx, created.customId);
        const before = await balances(models, ids);
        ctx.holder.session = executorSession(ids);
        const web = request(app)
            .post(`/executor-portal/api/complete-task/${txId}`)
            .set('Accept', 'application/json')
            .send({ executionNumber: '01055551903', senderEntries: [{ phone: '01055551903', amount: 131 }] });
        const mobile = request(app)
            .post(`/api/mobile/executor/complete-task/${txId}`)
            .set('Authorization', `Bearer ${mobileToken}`)
            .set('x-device-id', 'rc-review-device')
            .set('Accept', 'application/json')
            .send({ executionNumber: '01055551903', senderEntries: [{ phone: '01055551903', amount: 131 }] });
        const [webRes, mobileRes] = await Promise.all([web, mobile]);
        await sleep(300);
        const after = await balances(models, ids);
        return {
            customId: created.customId,
            webStatus: webRes.status,
            mobileStatus: mobileRes.status,
            webBody: webRes.body && (webRes.body.success !== undefined ? webRes.body.success : webRes.body.code || webRes.body.error),
            mobileBody: mobileRes.body && (mobileRes.body.success !== undefined ? mobileRes.body.success : mobileRes.body.code || mobileRes.body.message),
            tx: await txView(models, created.customId),
            humanDelta: round(after.humanExecutor - before.humanExecutor),
            clientDelta: round(after.client - before.client),
            ledger: await ledgerSummary(models, created.customId)
        };
    });

    await record('concurrent_split_completion', async () => {
        const created = await createTransfer(ctx, { amount: 250, phone: '01055551104' });
        const txId = await assignAndAccept(ctx, created.customId);
        const before = await balances(models, ids);
        const body = {
            executionNumber: '01108172258',
            senderEntries: [
                { phone: '01108172258', amount: 100 },
                { phone: '01000926306', amount: 150 }
            ]
        };
        ctx.holder.session = executorSession(ids);
        const responses = await Promise.all([0, 1].map(() => request(app)
            .post(`/executor-portal/api/complete-task/${txId}`)
            .set('Accept', 'application/json')
            .send(body)));
        await sleep(400);
        const after = await balances(models, ids);
        return {
            customId: created.customId,
            statuses: responses.map((res) => res.status),
            successes: responses.filter((res) => res.status < 400 && res.body && res.body.success !== false).length,
            tx: await txView(models, created.customId),
            humanDelta: round(after.humanExecutor - before.humanExecutor),
            clientDelta: round(after.client - before.client),
            ledger: await ledgerSummary(models, created.customId)
        };
    });

    const lifecycle = load('services/apiExecutionLifecycleService');

    await record('concurrent_complete_api_2_and_5', async () => {
        const first = await prepareDelayed(ctx, { amount: 141, phone: '01055551105', reference: 'LOCAL-CONC-2' });
        const second = await prepareDelayed(ctx, { amount: 142, phone: '01055551106', reference: 'LOCAL-CONC-5' });
        const tx2 = await models.Transaction.findOne({ customId: first });
        const tx5 = await models.Transaction.findOne({ customId: second });
        const before = await balances(models, ids);
        const paymentsBefore = httpMock.snapshotCounters().providerPayment;
        const two = await Promise.all([0, 1].map(() => lifecycle.completeApiTransaction(tx2._id, ids.apiGroup)));
        const five = await Promise.all([0, 1, 2, 3, 4].map(() => lifecycle.completeApiTransaction(tx5._id, ids.apiGroup)));
        await sleep(300);
        const after = await balances(models, ids);
        return {
            two: { customId: first, results: two, tx: await txView(models, first), ledger: await ledgerSummary(models, first) },
            five: { customId: second, results: five, tx: await txView(models, second), ledger: await ledgerSummary(models, second) },
            apiExecutorDelta: round(after.apiExecutor - before.apiExecutor),
            clientDelta: round(after.client - before.client),
            providerPayments: httpMock.snapshotCounters().providerPayment - paymentsBefore
        };
    });

    await record('crash_between_debit_and_save', async () => {
        const customId = await prepareDelayed(ctx, { amount: 143, phone: '01055551107', reference: 'LOCAL-CRASH' });
        const tx = await models.Transaction.findOne({ customId });
        const before = await balances(models, ids);
        global.__rcCrashCustomId = customId;
        const first = await lifecycle.completeApiTransaction(tx._id, ids.apiGroup);
        const thrown = global.__rcCrashCustomId === null;
        const mid = {
            tx: await txView(models, customId),
            balances: await balances(models, ids),
            ledger: await ledgerSummary(models, customId)
        };
        const second = await lifecycle.completeApiTransaction(tx._id, ids.apiGroup);
        const third = await lifecycle.completeApiTransaction(tx._id, ids.apiGroup);
        await sleep(200);
        const after = await balances(models, ids);
        return {
            customId,
            first,
            second,
            third,
            thrown,
            mid,
            finalTx: await txView(models, customId),
            finalLedger: await ledgerSummary(models, customId),
            apiExecutorDelta: round(after.apiExecutor - before.apiExecutor),
            clientDelta: round(after.client - before.client),
            providerPayments: 0
        };
    });

    await record('provider_timeout_5xx_then_retry', async () => {
        const created = await createTransfer(ctx, { amount: 151, phone: '01055551108' });
        const tx = await models.Transaction.findOne({ customId: created.customId });
        tx.status = 'processing';
        tx.executorGroupId = ids.apiGroup;
        await tx.save();
        httpMock.clearPaymentScript();
        httpMock.queuePaymentResult('timeout');
        httpMock.queuePaymentResult('connection');
        httpMock.queuePaymentResult('5xx');
        const paymentsBefore = httpMock.snapshotCounters().providerPayment;
        const queue = load('services/queueService');
        const before = await balances(models, ids);
        const attempts = [];
        for (let index = 0; index < 4; index += 1) {
            await queue.processSingleJob(tx._id, ids.apiGroup);
            const fresh = await models.Transaction.findById(tx._id);
            attempts.push({ status: fresh.status, executor: fresh.executorGroupId ? String(fresh.executorGroupId) : null });
            if (fresh.status === 'completed') break;
            if (fresh.status !== 'processing') {
                fresh.status = 'processing';
                fresh.executorGroupId = ids.apiGroup;
                await fresh.save();
            }
        }
        const finalTx = await models.Transaction.findOne({ customId: created.customId });
        const after = await balances(models, ids);
        return {
            customId: created.customId,
            attempts,
            finalStatus: finalTx.status,
            providerPayments: httpMock.snapshotCounters().providerPayment - paymentsBefore,
            apiExecutorDelta: round(after.apiExecutor - before.apiExecutor),
            clientDelta: round(after.client - before.client),
            ledger: await ledgerSummary(models, created.customId)
        };
    });

    await record('mongo_transient_error_mid_transfer', async () => {
        const before = await balances(models, ids);
        const originalFind = models.User.findOneAndUpdate.bind(models.User);
        let thrown = false;
        models.User.findOneAndUpdate = async function transientFindOneAndUpdate(...args) {
            const updated = await originalFind(...args);
            const increment = args[1] && args[1].$inc && args[1].$inc.balance;
            if (!thrown && typeof increment === 'number' && increment < 0) {
                thrown = true;
                const error = new Error('TransientTransactionError simulated');
                error.errorLabels = ['TransientTransactionError'];
                error.code = 112;
                throw error;
            }
            return updated;
        };
        ctx.holder.session = clientSession(ids.client, 'client');
        let failed;
        try {
            failed = await request(app)
                .post('/client/transfer')
                .set('Accept', 'application/json')
                .send({ amount: 150, type: 'كاش', phone: '01055551109', name: 'مستلم' });
        } finally {
            models.User.findOneAndUpdate = originalFind;
        }
        const mid = await balances(models, ids);
        const midCount = await models.Transaction.countDocuments({ vodafoneNumber: '01055551109' });
        const retried = await request(app)
            .post('/client/transfer')
            .set('Accept', 'application/json')
            .send({ amount: 150, type: 'كاش', phone: '01055551109', name: 'مستلم' });
        const after = await balances(models, ids);
        return {
            thrown,
            failedStatus: failed.status,
            failedBody: failed.body && (failed.body.error || failed.body.message || failed.body.success),
            retryStatus: retried.status,
            retryCustomId: retried.body && retried.body.customId,
            midCount,
            clientMidDelta: round(mid.client - before.client),
            clientFinalDelta: round(after.client - before.client),
            ledger: retried.body && retried.body.customId ? await ledgerSummary(models, retried.body.customId) : null
        };
    });

    await record('write_conflict_completion_retry', async () => {
        const customId = await prepareDelayed(ctx, { amount: 144, phone: '01055551121', reference: 'LOCAL-WRITE-CONFLICT' });
        const tx = await models.Transaction.findOne({ customId });
        const before = await balances(models, ids);
        const paymentsBefore = httpMock.snapshotCounters().providerPayment;
        global.__rcWriteConflictAttempts = 0;
        global.__rcWriteConflictCustomId = customId;
        const first = await lifecycle.completeApiTransaction(tx._id, ids.apiGroup);
        const afterFirst = {
            result: first,
            attempts: global.__rcWriteConflictAttempts,
            tx: await txView(models, customId),
            ledger: await ledgerSummary(models, customId)
        };
        const second = afterFirst.tx && afterFirst.tx.status === 'completed'
            ? { skipped: true }
            : await lifecycle.completeApiTransaction(tx._id, ids.apiGroup);
        const after = await balances(models, ids);
        return {
            customId,
            afterFirst,
            second,
            finalTx: await txView(models, customId),
            finalLedger: await ledgerSummary(models, customId),
            apiExecutorDelta: round(after.apiExecutor - before.apiExecutor),
            clientDelta: round(after.client - before.client),
            providerPayments: httpMock.snapshotCounters().providerPayment - paymentsBefore
        };
    });

    await record('immediate_crash_after_provider_accept', async () => {
        const created = await createTransfer(ctx, { amount: 152, phone: '01055551122' });
        const tx = await models.Transaction.findOne({ customId: created.customId });
        tx.status = 'processing';
        tx.executorGroupId = ids.apiGroup;
        await tx.save();
        const originalSave = models.Transaction.prototype.save;
        models.Transaction.prototype.save = async function crashSave(...args) {
            if (this.customId === created.customId) {
                throw new Error('hard crash after provider accept before save');
            }
            return originalSave.apply(this, args);
        };
        const paymentsBefore = httpMock.snapshotCounters().providerPayment;
        const before = await balances(models, ids);
        const queue = load('services/queueService');
        let firstError = null;
        try {
            await queue.processSingleJob(tx._id, ids.apiGroup);
        } catch (error) {
            firstError = error.message;
        }
        models.Transaction.prototype.save = originalSave;
        const mid = {
            tx: await txView(models, created.customId),
            ledger: await ledgerSummary(models, created.customId),
            providerPayments: httpMock.snapshotCounters().providerPayment - paymentsBefore,
            firstError
        };
        if (mid.tx && mid.tx.status !== 'processing') {
            const fresh = await models.Transaction.findOne({ customId: created.customId });
            fresh.status = 'processing';
            fresh.executorGroupId = ids.apiGroup;
            await fresh.save();
            mid.restoredProcessing = true;
        }
        await queue.processSingleJob(tx._id, ids.apiGroup);
        const after = await balances(models, ids);
        return {
            customId: created.customId,
            mid,
            finalTx: await txView(models, created.customId),
            finalLedger: await ledgerSummary(models, created.customId),
            providerPayments: httpMock.snapshotCounters().providerPayment - paymentsBefore,
            apiExecutorDelta: round(after.apiExecutor - before.apiExecutor),
            clientDelta: round(after.client - before.client)
        };
    });

    await record('ambiguous_provider_result_no_automatic_resend', async () => {
        const created = await createTransfer(ctx, { amount: 153, phone: '01055551123' });
        const tx = await models.Transaction.findOne({ customId: created.customId });
        tx.status = 'processing';
        tx.executorGroupId = ids.apiGroup;
        await tx.save();
        httpMock.clearPaymentScript();
        httpMock.queuePaymentResult('timeout');
        const paymentsBefore = httpMock.snapshotCounters().providerPayment;
        const before = await balances(models, ids);
        const queue = load('services/queueService');
        await queue.processSingleJob(tx._id, ids.apiGroup);
        const afterFailure = await txView(models, created.customId);
        const ledgerAfterFailure = await ledgerSummary(models, created.customId);
        await lifecycle.completeDueApiTransactions();
        const bull = load('services/bullQueueService');
        if (typeof bull.addTransferJob === 'function') {
            await bull.addTransferJob(String(tx._id), String(ids.apiGroup));
        }
        await sleep(400);
        const after = await balances(models, ids);
        return {
            customId: created.customId,
            afterFailure,
            ledgerAfterFailure,
            finalTx: await txView(models, created.customId),
            finalLedger: await ledgerSummary(models, created.customId),
            providerPayments: httpMock.snapshotCounters().providerPayment - paymentsBefore,
            apiExecutorDelta: round(after.apiExecutor - before.apiExecutor),
            clientDelta: round(after.client - before.client),
            refundLedgerRows: (await models.Ledger.find({ transactionId: created.customId, type: 'REFUND' }).lean()).length
        };
    });

    if (profile === 'rc') {
        await record('bullmq_restart_and_stale_notification', async () => {
            const bullmq = require('bullmq');
            const bull = load('services/bullQueueService');
            await models.Notification.collection.createIndex({ dedupeKey: 1 }, { unique: true, sparse: true });
            bull.initBullMQ();
            const key = 'transfer:completed:rc-review-stale';
            await bull.addNotificationJob(String(ids.client), 'إيصال', 'تمت العملية', 'transfer', key);
            await sleep(700);
            const afterFirst = await models.Notification.countDocuments({ dedupeKey: key });
            const redisUrl = new URL(process.env.REDIS_URL || process.env.RC_REDIS_URL);
            const connection = {
                host: redisUrl.hostname,
                port: Number(redisUrl.port || 6379),
                db: Number((redisUrl.pathname || '/0').slice(1) || 0)
            };
            const queue = new bullmq.Queue('notifications-queue', { connection });
            let staleAdd = 'queued';
            try {
                await queue.add('stale-replay', {
                    userId: String(ids.client),
                    title: 'إيصال',
                    message: 'تمت العملية',
                    type: 'transfer',
                    dedupeKey: key
                }, { jobId: 'stale-replay-rc-review' });
            } catch (error) {
                staleAdd = error.message;
            }
            await bull.addNotificationJob(String(ids.client), 'إيصال', 'تمت العملية', 'transfer', key);
            bull.resetBullMQState();
            const restarted = bull.initBullMQ();
            await sleep(1000);
            const afterReplay = await models.Notification.countDocuments({ dedupeKey: key });
            const waiting = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
            await queue.close();
            return {
                afterFirst,
                staleAdd,
                restarted,
                afterReplay,
                notificationRows: afterReplay,
                queuedJobsSeen: waiting.length
            };
        });

        await record('webhook_crash_after_2xx', async () => {
            const restoreDns = installDnsStub();
            const { encrypt } = load('utils/encryption');
            const Endpoint = load('models/MerchantWebhookEndpoint');
            const Delivery = load('models/MerchantWebhookDelivery');
            const endpoint = await Endpoint.create({
                ownerModel: 'User',
                ownerId: ids.agent,
                name: 'rc-review',
                url: 'https://rc-review.example/hook',
                secretEncrypted: encrypt('rc-review-webhook-secret'),
                events: ['transfer.completed'],
                enabled: true
            });
            const delivery = await Delivery.create({
                endpointId: endpoint._id,
                ownerModel: 'User',
                ownerId: ids.agent,
                eventId: 'rc-review-event-1',
                eventType: 'transfer.completed',
                payload: { id: 'rc-review-event-1', type: 'transfer.completed', data: { amount: 1 } },
                status: 'pending',
                nextAttemptAt: new Date(Date.now() - 1000)
            });
            const beforeLedger = await models.Ledger.countDocuments();
            const beforeBalances = await balances(models, ids);
            const postsBefore = httpMock.snapshotCounters().webhookPosts;
            const originalUpdate = Delivery.updateOne;
            let crashed = false;
            Delivery.updateOne = function updateOne(filter, update, ...rest) {
                if (!crashed && update && update.$set && update.$set.status === 'delivered') {
                    crashed = true;
                    throw new Error('crash after merchant 2xx before success is recorded');
                }
                return originalUpdate.call(this, filter, update, ...rest);
            };
            const webhook = load('services/merchantWebhookService');
            const first = await webhook.deliverWebhook(delivery._id);
            const mid = await Delivery.findById(delivery._id).lean();
            Delivery.updateOne = originalUpdate;
            await Delivery.updateOne({ _id: delivery._id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000), lockedAt: null } });
            const second = await webhook.deliverWebhook(delivery._id);
            const finalRow = await Delivery.findById(delivery._id).lean();
            const posts = httpMock.snapshotCounters().webhookPosts - postsBefore;
            const eventIds = httpMock.snapshotCounters().calls.filter((call) => call.kind === 'webhookPosts').map((call) => call.eventId);
            restoreDns();
            return {
                first,
                second,
                crashed,
                midStatus: mid && mid.status,
                finalStatus: finalRow && finalRow.status,
                attemptCount: finalRow && finalRow.attemptCount,
                webhookPosts: posts,
                eventIds,
                ledgerDelta: (await models.Ledger.countDocuments()) - beforeLedger,
                balancesUnchanged: JSON.stringify(beforeBalances) === JSON.stringify(await balances(models, ids))
            };
        });

        await record('switch_cycle', async () => {
            const pendingId = (await createTransfer(ctx, { amount: 161, phone: '01055551110' })).customId;
            const processing = await models.Transaction.findOne({ customId: (await createTransfer(ctx, { amount: 162, phone: '01055551111' })).customId });
            processing.status = 'processing';
            processing.executorGroupId = ids.apiGroup;
            processing.executorName = 'منفذ API مراجعة';
            await processing.save();
            const paidA = await prepareDelayed(ctx, { amount: 163, phone: '01055551112', reference: 'LOCAL-SWITCH-A' });
            const paidB = await prepareDelayed(ctx, { amount: 164, phone: '01055551113', reference: 'LOCAL-SWITCH-B' });
            const restoreDns = installDnsStub();
            const { encrypt } = load('utils/encryption');
            const Endpoint = load('models/MerchantWebhookEndpoint');
            const Delivery = load('models/MerchantWebhookDelivery');
            const endpoint = await Endpoint.create({
                ownerModel: 'ClientCompany',
                ownerId: ids.company,
                name: 'switch',
                url: 'https://rc-review.example/hook',
                secretEncrypted: encrypt('rc-review-webhook-secret'),
                events: ['transfer.completed'],
                enabled: true
            });
            await Delivery.create({
                endpointId: endpoint._id,
                ownerModel: 'ClientCompany',
                ownerId: ids.company,
                eventId: 'switch-pending',
                eventType: 'transfer.completed',
                payload: { id: 'switch-pending', type: 'transfer.completed' },
                status: 'pending',
                nextAttemptAt: new Date(Date.now() - 1000)
            });
            await Delivery.create({
                endpointId: endpoint._id,
                ownerModel: 'ClientCompany',
                ownerId: ids.company,
                eventId: 'switch-failed',
                eventType: 'transfer.completed',
                payload: { id: 'switch-failed', type: 'transfer.completed' },
                status: 'failed',
                nextAttemptAt: new Date(Date.now() - 1000),
                attemptCount: 1
            });
            await Delivery.create({
                endpointId: endpoint._id,
                ownerModel: 'ClientCompany',
                ownerId: ids.company,
                eventId: 'switch-sending',
                eventType: 'transfer.completed',
                payload: { id: 'switch-sending', type: 'transfer.completed' },
                status: 'sending',
                lockedAt: new Date(Date.now() - (3 * 60 * 1000)),
                attemptCount: 1
            });
            const bull = load('services/bullQueueService');
            bull.initBullMQ();
            await bull.addNotificationJob(String(ids.client), 'قبل الإيقاف', 'صف', 'system_alert', 'switch-cycle-notice');
            await sleep(500);
            const { countIsolationBacklog } = load('scripts/countIsolationBacklog');
            const { listProviderPaidAwaitingCompletion } = load('scripts/listProviderPaidAwaitingCompletion');
            const beforeCounts = await countIsolationBacklog(mongoose.connection.db);
            const beforeRows = await listProviderPaidAwaitingCompletion(models.Transaction);
            const customerBefore = await balances(models, ids);
            const executorDebitsBefore = await models.Ledger.countDocuments({ entityModel: 'ExecutorGroup', transactionId: { $in: [paidA, paidB] } });

            const off = ['EXTERNAL_API_ENABLED', 'BULLMQ_WORKERS_ENABLED', 'FINANCIAL_SCHEDULERS_ENABLED', 'MERCHANT_WEBHOOK_WORKER_ENABLED'];
            off.forEach((name) => { process.env[name] = 'false'; });
            const opened = [];
            bull.resetBullMQState();
            const disposable = await createTransfer(ctx, { amount: 160, phone: '01055551114' });
            const disposableTx = await models.Transaction.findOne({ customId: disposable.customId });
            disposableTx.status = 'processing';
            disposableTx.executorGroupId = ids.apiGroup;
            await disposableTx.save();
            const paymentsBefore = httpMock.snapshotCounters().providerPayment;
            const queue = load('services/queueService');
            await queue.processSingleJob(disposableTx._id, ids.apiGroup);
            const disabledCompletion = await lifecycle.completeApiTransaction(
                (await models.Transaction.findOne({ customId: paidA }))._id,
                ids.apiGroup
            );
            await lifecycle.completeDueApiTransactions();
            const webhook = load('services/merchantWebhookService');
            const skipped = await webhook.processPendingWebhooks();
            const duringOff = {
                backlog: await countIsolationBacklog(mongoose.connection.db),
                paidRows: (await listProviderPaidAwaitingCompletion(models.Transaction)).map((row) => row.customId),
                pendingStatus: (await txView(models, pendingId)).status,
                processingStatus: (await txView(models, processing.customId)).status,
                disposable: await txView(models, disposable.customId),
                providerPayments: httpMock.snapshotCounters().providerPayment - paymentsBefore,
                disabledCompletion,
                webhookBatch: skipped,
                customer: await balances(models, ids)
            };

            delete process.env.EXTERNAL_API_ENABLED;
            const afterExternal = await countIsolationBacklog(mongoose.connection.db);
            delete process.env.BULLMQ_WORKERS_ENABLED;
            bull.initBullMQ();
            await sleep(400);
            const afterBull = await countIsolationBacklog(mongoose.connection.db);
            delete process.env.FINANCIAL_SCHEDULERS_ENABLED;
            const paymentsAtSchedulers = httpMock.snapshotCounters().providerPayment;
            await lifecycle.completeDueApiTransactions();
            await sleep(400);
            const afterSchedulers = {
                backlog: await countIsolationBacklog(mongoose.connection.db),
                paidA: await txView(models, paidA),
                paidB: await txView(models, paidB),
                ledgerA: await ledgerSummary(models, paidA),
                ledgerB: await ledgerSummary(models, paidB),
                providerPayments: httpMock.snapshotCounters().providerPayment - paymentsAtSchedulers,
                executorDebitRows: await models.Ledger.countDocuments({ entityModel: 'ExecutorGroup', transactionId: { $in: [paidA, paidB] } })
            };
            delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
            await webhook.processPendingWebhooks();
            const afterWebhook = await countIsolationBacklog(mongoose.connection.db);
            const customerAfter = await balances(models, ids);
            restoreDns();
            const runScript = (scriptName) => {
                const result = require('child_process').spawnSync(process.execPath, [
                    path.join(targetRoot, 'scripts', scriptName)
                ], {
                    cwd: targetRoot,
                    env: { ...process.env, MONGO_URI: process.env.RC_MONGO_URI, DOTENV_CONFIG_PATH: '/tmp/rc-review-empty.env' },
                    encoding: 'utf8',
                    timeout: 60000
                });
                return {
                    status: result.status,
                    stdout: result.stdout || '',
                    stderr: (result.stderr || '').slice(-800)
                };
            };
            fs.writeFileSync('/tmp/rc-review-empty.env', '');
            const scriptAfter = {
                countIsolationBacklog: runScript('countIsolationBacklog.js'),
                listProviderPaidAwaitingCompletion: runScript('listProviderPaidAwaitingCompletion.js')
            };
            return {
                beforeCounts,
                beforePaidCustomIds: beforeRows.map((row) => row.customId),
                executorDebitsBefore,
                duringOff,
                afterExternalApiEnabled: afterExternal,
                afterBullmqEnabled: afterBull,
                afterSchedulers,
                afterWebhook,
                customerBefore,
                customerAfter,
                scriptAfter,
                customerUnchangedOnPaid: customerBefore.client === customerAfter.client
                    ? false
                    : {
                        before: customerBefore.client,
                        after: customerAfter.client,
                        note: 'client balance may change because a new disposable transfer was created while switches were off'
                    }
            };
        });

        await record('split_part_proofs', async () => {
            const created = await createTransfer(ctx, { amount: 2500, phone: '01055551120' });
            const txId = await assignAndAccept(ctx, created.customId);
            ctx.holder.session = executorSession(ids);
            const completed = await request(app)
                .post(`/executor-portal/api/complete-task/${txId}`)
                .set('Accept', 'application/json')
                .send({
                    executionNumber: '01108172258',
                    senderEntries: [
                        { phone: '01108172258', amount: 1000 },
                        { phone: '01000926306', amount: 1500 }
                    ]
                });
            await sleep(500);
            const before = await financialFingerprint(models);
            const ledgerBefore = await models.Ledger.countDocuments();
            const txCountBefore = await models.Transaction.countDocuments();
            const proofs = load('services/splitPartProofService');
            const receipt = load('utils/manualExecutorReceipt');
            const originalRender = receipt.generateManualExecutorReceiptBase64;
            const generation = await proofs.issueSplitPartProofs(txId);
            const afterGeneration = await financialFingerprint(models);
            receipt.generateManualExecutorReceiptBase64 = async () => {
                throw new Error('canvas threw in rc-review');
            };
            const canvasFailure = await proofs.retrySplitPartProof(txId, '1');
            const afterCanvasTx = await txView(models, created.customId);
            receipt.generateManualExecutorReceiptBase64 = originalRender;
            const afterCanvas = await financialFingerprint(models);
            ctx.holder.session = adminSession(ids);
            const adminRetry = await request(app)
                .post(`/transaction/${txId}/retry-part-proof/1`)
                .set('Accept', 'application/json')
                .send({});
            ctx.holder.session = executorSession(ids);
            const executorRetry = await request(app)
                .post(`/executor-portal/api/retry-part-proof/${txId}/2`)
                .set('Accept', 'application/json')
                .send({});
            await models.Transaction.updateOne({ _id: txId }, { $set: { tenantId } });
            const mobileRetry = await request(app)
                .post(`/api/mobile/executor/retry-part-proof/${txId}/1`)
                .set('Authorization', `Bearer ${mobileToken}`)
                .set('x-device-id', 'rc-review-device')
                .send({});
            const script = require('child_process').spawnSync(process.execPath, [
                path.join(targetRoot, 'scripts/retrySplitPartProof.js'),
                String(txId),
                '2'
            ], {
                cwd: targetRoot,
                env: { ...process.env, MONGO_URI: process.env.RC_MONGO_URI },
                encoding: 'utf8',
                timeout: 60000
            });
            const concurrent = await Promise.all([
                proofs.retrySplitPartProof(txId, '1'),
                proofs.retrySplitPartProof(txId, '1')
            ]);
            const after = await financialFingerprint(models);
            return {
                completeStatus: completed.status,
                generation,
                canvasFailure,
                afterCanvasTx,
                adminRetry: { status: adminRetry.status, body: adminRetry.body },
                executorRetry: { status: executorRetry.status, body: executorRetry.body },
                mobileRetry: { status: mobileRetry.status, body: mobileRetry.body },
                scriptStatus: script.status,
                scriptStdout: (script.stdout || '').slice(0, 1000),
                scriptStderr: (script.stderr || '').slice(-1000),
                concurrent,
                tx: await txView(models, created.customId),
                financialUnchanged: before === afterGeneration && afterGeneration === afterCanvas && afterCanvas === after,
                ledgerDelta: (await models.Ledger.countDocuments()) - ledgerBefore,
                transactionDelta: (await models.Transaction.countDocuments()) - txCountBefore,
                providerPaymentsDuringProofs: 0
            };
        });
    }

    const output = {
        profile,
        targetRoot,
        sha: process.env.RC_SHA || null,
        mongo: {
            version: buildInfo.version,
            setName: hello.setName || null
        },
        redisUrl: process.env.REDIS_URL || process.env.RC_REDIS_URL,
        results
    };
    fs.mkdirSync('/tmp/rc-review', { recursive: true });
    const outFile = process.env.RC_OUT || `/tmp/rc-review/resilience-${profile}.json`;
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(JSON.stringify({
        profile,
        cases: Object.fromEntries(Object.entries(results).map(([name, row]) => [name, row.ok]))
    }, null, 2));
    await Promise.race([
        mongoose.disconnect(),
        sleep(2000)
    ]);
    process.exit(0);
};

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
