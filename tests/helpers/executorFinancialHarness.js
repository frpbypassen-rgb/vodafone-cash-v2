'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const { assertLocalMemoryMongoUri, randomDatabaseName } = require('./localMemoryMongo');

const CSRF_TOKEN = 'executor-financial-csrf-token';
const RATE = 50;
const AMOUNT = 1000;
const COST = 20;
const COMMISSION = 1.5;
const OPENING_BALANCE = 500;
const POOL_DEPOSIT = 5000;
const TINY_JPEG = 'data:image/jpeg;base64,AAECAwQ=';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

const SESSION_ENDED = 'ط§ظ†طھظ‡طھ ط¬ظ„ط³ط© ط§ظ„ط¯ط®ظˆظ„.';
const TASK_FORBIDDEN = 'ظ‡ط°ط§ ط§ظ„ط­ط³ط§ط¨ ظ„ط§ ظٹظ…ظ„ظƒ طµظ„ط§ط­ظٹط© طھظ†ظپظٹط° ط§ظ„ط¹ظ…ظ„ظٹط§طھ.';

const PROOFS_DIR = path.join(process.cwd(), 'uploads', 'proofs');

let replset;

const rememberEnv = {};
const trackedEnv = [
    'NODE_ENV',
    'BULLMQ_WORKERS_ENABLED',
    'EXTERNAL_API_ENABLED',
    'WHATCHIMP_ENABLED',
    'REDIS_ENABLED',
    'REDIS_URL',
    'REDIS_URI',
    'REDIS_REQUIRED',
    'ALLOW_LEGACY_SAME_ORIGIN_CSRF',
    'MONGO_URI'
];

const applyIsolatedEnv = () => {
    trackedEnv.forEach((name) => {
        if (!Object.prototype.hasOwnProperty.call(rememberEnv, name)) {
            rememberEnv[name] = process.env[name];
        }
    });
    process.env.NODE_ENV = 'test';
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
        process.env.JWT_SECRET = 'executor-financial-contract-test-jwt-secret';
    }
    if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32) {
        process.env.JWT_REFRESH_SECRET = 'executor-financial-contract-test-refresh-secret';
    }
    process.env.BULLMQ_WORKERS_ENABLED = 'false';
    process.env.EXTERNAL_API_ENABLED = 'false';
    process.env.WHATCHIMP_ENABLED = 'false';
    process.env.REDIS_ENABLED = 'false';
    delete process.env.REDIS_URL;
    delete process.env.REDIS_URI;
    delete process.env.REDIS_REQUIRED;
    delete process.env.ALLOW_LEGACY_SAME_ORIGIN_CSRF;
    delete process.env.MONGO_URI;
};

const restoreEnv = () => {
    trackedEnv.forEach((name) => {
        if (rememberEnv[name] === undefined) delete process.env[name];
        else process.env[name] = rememberEnv[name];
    });
};

const startMemoryMongo = async () => {
    applyIsolatedEnv();
    mongoose.set('autoIndex', false);
    replset = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' }
    });
    const databaseName = randomDatabaseName('executor_fin');
    const uri = assertLocalMemoryMongoUri(replset.getUri(databaseName));
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(uri);
    return { databaseName };
};

const stopMemoryMongo = async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (replset) await replset.stop();
    replset = null;
    restoreEnv();
};

const ensureIndexes = async (models) => {
    for (const model of models) {
        await model.createCollection().catch((error) => {
            if (error.code !== 48) throw error;
        });
        await model.createIndexes().catch((error) => {
            if (![85, 86].includes(error.code)) throw error;
        });
    }
};

const buildApp = () => {
    const csrfProtection = require('../../middlewares/csrfProtection');
    const portal = require('../../routes/executorPortal');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => {
        const executorId = String(req.get('x-test-executor') || '');
        const loggedOut = req.get('x-test-auth') === 'none';
        req.session = {
            isExecutorLoggedIn: !loggedOut && Boolean(executorId),
            executorId: executorId || undefined,
            csrfToken: CSRF_TOKEN
        };
        next();
    });
    app.use(csrfProtection);
    app.use('/executor-portal', portal);
    return app;
};

const postJson = (app, url, body, { employee, csrf = true, auth = 'session' } = {}) => {
    const req = request(app).post(url).send(body || {});
    if (auth === 'none') req.set('x-test-auth', 'none');
    if (employee) req.set('x-test-executor', String(employee._id));
    if (csrf) req.set('x-csrf-token', CSRF_TOKEN);
    return req;
};

const serviceBalance = (group, key = 'vodafone') => {
    const raw = group && group.serviceBalances;
    if (!raw) return 0;
    if (typeof raw.get === 'function') return Number(raw.get(key) || 0);
    return Number(raw[key] || 0);
};

const stableBody = (body) => {
    const source = body || {};
    return {
        success: source.success,
        code: source.code === undefined ? null : source.code,
        error: source.error === undefined ? null : source.error,
        message: source.message === undefined ? null : source.message,
        newAmount: source.newAmount === undefined ? null : source.newAmount,
        replayed: source.replayed === undefined ? null : source.replayed,
        transactionNumber: source.transactionNumber === undefined ? null : source.transactionNumber
    };
};

const createBarrier = (parties) => {
    let arrived = 0;
    let openGate;
    const opened = new Promise((resolve) => {
        openGate = resolve;
    });
    return {
        async enter() {
            arrived += 1;
            if (arrived >= parties) openGate();
            await opened;
        }
    };
};

const waitFor = async (predicate, timeoutMs = 4000) => {
    const started = Date.now();
    let value;
    while (Date.now() - started < timeoutMs) {
        value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return value;
};

const removeProofs = (customId) => {
    if (!customId || !fs.existsSync(PROOFS_DIR)) return;
    const safeId = String(customId).replace(/[^a-zA-Z0-9_-]/g, '');
    for (const name of fs.readdirSync(PROOFS_DIR)) {
        if (name.startsWith(safeId)) fs.unlinkSync(path.join(PROOFS_DIR, name));
    }
};

const id = () => crypto.randomBytes(3).toString('hex');

module.exports = {
    AMOUNT,
    COMMISSION,
    COST,
    CSRF_TOKEN,
    OPENING_BALANCE,
    POOL_DEPOSIT,
    PROOFS_DIR,
    RATE,
    SESSION_ENDED,
    TASK_FORBIDDEN,
    TINY_JPEG,
    TINY_PNG,
    buildApp,
    createBarrier,
    ensureIndexes,
    id,
    postJson,
    removeProofs,
    serviceBalance,
    stableBody,
    startMemoryMongo,
    stopMemoryMongo,
    waitFor
};
