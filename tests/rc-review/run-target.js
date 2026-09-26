'use strict';

require('./productionEnv').applyProductionEnv();
const httpMock = require('./httpMock');
httpMock.install();

require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'CommonJS' }
});

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { seed } = require('./seed');
const { takeSnapshot, summarize } = require('./snapshot');
const { runScenarios } = require('./scenarios');

const targetRoot = path.resolve(process.env.RC_TARGET || process.cwd());

const load = (relativePath) => require(path.join(targetRoot, relativePath));

const buildApp = (holder) => {
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.use((req, _res, next) => {
        req.session = holder.session;
        if (req.session && typeof req.session.destroy !== 'function') {
            req.session.destroy = (callback) => { if (callback) callback(); };
        }
        next();
    });
    app.use('/client', load('routes/clientPortal'));
    app.use('/executor-portal', load('routes/executorPortal'));
    app.use('/api/v1/merchant', load('routes/merchantApi'));
    app.use('/', load('routes/adminTransactions'));
    app.use('/', load('routes/clients'));
    app.use('/', load('routes/executors'));
    return app;
};

const main = async () => {
    const mongoUri = process.env.RC_MONGO_URI || process.env.MONGO_URI;
    if (!mongoUri) throw new Error('RC_MONGO_URI is required');
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');

    const Redis = require('ioredis');
    const flusher = new Redis(process.env.REDIS_URL);
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
    const balanceTransfer = load('services/balanceTransferService');
    const originalBalanceTransfer = balanceTransfer.executeBalanceTransfer;
    balanceTransfer.executeBalanceTransfer = async (...args) => {
        try {
            return await originalBalanceTransfer(...args);
        } catch (error) {
            console.error('[rc-review balance transfer]', error.message);
            throw error;
        }
    };
    const holder = { session: {} };
    const app = buildApp(holder);
    const checkpoints = await runScenarios({
        app,
        holder,
        ids,
        models,
        load,
        http: httpMock,
        snapshot: () => takeSnapshot(models)
    });

    const finalSnapshot = await takeSnapshot(models);
    const output = {
        label: process.env.RC_LABEL || 'target',
        targetRoot,
        sha: process.env.RC_SHA || null,
        mongo: {
            version: buildInfo.version,
            setName: hello.setName || null,
            writablePrimary: Boolean(hello.isWritablePrimary)
        },
        switches: {
            EXTERNAL_API_ENABLED: process.env.EXTERNAL_API_ENABLED || null,
            BULLMQ_WORKERS_ENABLED: process.env.BULLMQ_WORKERS_ENABLED || null,
            FINANCIAL_SCHEDULERS_ENABLED: process.env.FINANCIAL_SCHEDULERS_ENABLED || null,
            MERCHANT_WEBHOOK_WORKER_ENABLED: process.env.MERCHANT_WEBHOOK_WORKER_ENABLED || null,
            NODE_ENV: process.env.NODE_ENV,
            APP_ENV: process.env.APP_ENV || null,
            ENVIRONMENT: process.env.ENVIRONMENT || null
        },
        http: httpMock.snapshotCounters(),
        summary: summarize(finalSnapshot),
        checkpoints,
        finalSnapshot
    };

    const outPath = process.env.RC_OUT;
    if (outPath) fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    const brief = {
        label: output.label,
        sha: output.sha,
        mongoVersion: output.mongo.version,
        setName: output.mongo.setName,
        scenarios: Object.fromEntries(Object.entries(checkpoints).map(([name, row]) => [name, {
            ok: row.ok,
            error: row.error ? String(row.error).split('\n')[0] : null,
            providerPayments: row.providerPayments,
            detail: row.detail || null
        }]))
    };
    console.log(JSON.stringify(brief, null, 2));
    await mongoose.disconnect();
    process.exit(0);
};

main().catch(async (error) => {
    console.error(error.stack || error.message);
    try { await mongoose.disconnect(); } catch (_error) {}
    process.exit(1);
});
