'use strict';

// This runner owns every database, process and account it creates.
// It accepts no server URL, source database URI, production key or provider URL.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, fork } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
};

const localUri = (value) => /^mongodb:\/\/127\.0\.0\.1:\d+\/ahram_audit_[a-f\d]+\?/.test(value || '');
const localRedisUri = (value) => {
    try {
        const uri = new URL(value);
        return (
            uri.protocol === 'redis:' &&
            uri.hostname === '127.0.0.1' &&
            Boolean(uri.port) &&
            uri.username === '' &&
            /^[a-f\d]{64}$/.test(uri.password)
        );
    } catch (_) {
        return false;
    }
};
const worker = () => {
    if (!localUri(process.env.MONGO_URI) || !localRedisUri(process.env.REDIS_URL)) {
        throw new Error('AUDIT_DISPOSABLE_DATABASE_REQUIRED');
    }
    const connect = net.Socket.prototype.connect;
    let blockedConnections = 0;
    let activeRequests = 0;
    const serverPrototype = require('node:http').Server.prototype;
    const emit = serverPrototype.emit;
    serverPrototype.emit = function (event, ...args) {
        if (event === 'request') {
            const response = args[1];
            const end = response.end;
            let ended = false;
            activeRequests++;
            response.end = function (...endArgs) {
                if (!ended) { ended = true; activeRequests--; }
                return end.apply(this, endArgs);
            };
        }
        return emit.call(this, event, ...args);
    };
    net.Socket.prototype.connect = function (...args) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const host =
            typeof first === 'object'
                ? first.host || first.hostname
                : typeof args[1] === 'string'
                  ? args[1]
                  : null;
        if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
            blockedConnections++;
            throw new Error('AUDIT_EXTERNAL_NETWORK_BLOCKED');
        }
        return connect.apply(this, args);
    };
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    const timer = setInterval(() => {
        if (process.connected)
            process.send({
                type: 'sample',
                rssMiB: process.memoryUsage().rss / 1048576,
                eventLoopP99Ms: delay.percentile(99) / 1e6,
                cpu: process.cpuUsage(),
                blockedConnections,
                activeRequests,
            });
        delay.reset();
    }, 1000);
    timer.unref();
    require('../app');
};

const unusedPort = () =>
    new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close((error) => (error ? reject(error) : resolve(port)));
        });
    });
const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0;
};
const cleanEnvironment = () =>
    Object.fromEntries(
        [
            'SystemRoot',
            'SYSTEMROOT',
            'WINDIR',
            'PATH',
            'Path',
            'TEMP',
            'TMP',
            'USERPROFILE',
            'APPDATA',
            'LOCALAPPDATA',
            'COMSPEC',
        ]
            .filter((key) => process.env[key])
            .map((key) => [key, process.env[key]])
    );

const main = async () => {
    const output = path.resolve(option('--output', path.join(root, 'outputs/isolated-system-load.json')));
    const seconds = Number(option('--seconds', '15'));
    const steps = String(option('--steps', '1,5,10,25,50,100,200,400')).split(',').map(Number);
    if (!(seconds >= 3 && seconds <= 120) || steps.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)) {
        throw new Error('INVALID_LOAD_LIMITS');
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    const mongoose = require('mongoose');
    const Redis = require('ioredis');
    const runId = crypto.randomBytes(8).toString('hex');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahram-audit-' + runId + '-'));
    let replica,
        redisProcess,
        appProcess,
        redis,
        log,
        redisOwned = false,
        activeStage = 'startup';
    const report = {
        runId,
        startedAt: new Date().toISOString(),
        baseCommit: '2815206',
        method: 'Full app.js, real loopback HTTP, disposable Mongo replica set and Redis, synthetic wallets',
        host: {
            platform: process.platform,
            node: process.version,
            cpus: os.cpus().length,
            ramGiB: os.totalmem() / 1073741824,
        },
        limits: {
            externalProvidersDisabled: true,
            queuesDisabled: true,
            financialSchedulersDisabled: true,
            globalRateLimitMax: 1000000,
            requestTimeoutMs: 25000,
            measuredSecondsPerStep: seconds,
        },
        stages: [],
        samples: [],
    };
    const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
    try {
        replica = await MongoMemoryReplSet.create({
            instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.5'] }],
            replSet: { count: 1, storageEngine: 'wiredTiger' },
        });
        const uri = replica.getUri('ahram_audit_' + runId);
        if (!localUri(uri)) throw new Error('AUDIT_MONGO_ISOLATION_REFUSED');
        const redisPort = await unusedPort();
        const redisPassword = crypto.randomBytes(32).toString('hex');
        const redisBinary = option(
            '--redis-binary',
            process.platform === 'win32' ? 'C:/Program Files/Redis/redis-server.exe' : 'redis-server'
        );
        log = fs.createWriteStream(output + '.server.log');
        redisProcess = spawn(
            redisBinary,
            [
                '--bind',
                '127.0.0.1',
                '--port',
                String(redisPort),
                '--requirepass',
                redisPassword,
                '--save',
                '',
                '--appendonly',
                'no',
                '--dir',
                temp,
                '--maxmemory',
                '128mb',
                '--maxmemory-policy',
                'noeviction',
            ],
            { env: cleanEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        redisProcess.on('error', (error) => {
            report.redisStartupError = error.message;
        });
        redisProcess.stdout.pipe(log, { end: false });
        redisProcess.stderr.pipe(log, { end: false });
        redis = new Redis({
            host: '127.0.0.1',
            port: redisPort,
            password: redisPassword,
            lazyConnect: true,
            connectTimeout: 1000,
            retryStrategy: () => null,
            maxRetriesPerRequest: 0,
        });
        redis.on('error', () => {});
        for (let attempt = 0; ; attempt++) {
            if (redisProcess.exitCode !== null || redisProcess.signalCode !== null)
                throw new Error('AUDIT_REDIS_CHILD_EXITED');
            try {
                await redis.connect();
                await redis.ping();
                break;
            } catch (error) {
                if (attempt >= 15) throw error;
                await sleep(200);
            }
        }
        const redisInfo = await redis.info('server');
        if (Number(redisInfo.match(/process_id:(\d+)/)?.[1]) !== redisProcess.pid)
            throw new Error('AUDIT_REDIS_OWNERSHIP_MISMATCH');
        redisOwned = true;
        report.redisVersion = redisInfo.match(/redis_version:([^\r\n]+)/)?.[1];
        await mongoose.connect(uri);
        const Company = require('../models/ClientCompany');
        const User = require('../models/User');
        const Transaction = require('../models/Transaction');
        const Ledger = require('../models/Ledger');
        const Counter = require('../models/Counter');
        const Settings = require('../models/Settings');
        await Promise.all(
            [Company, User, Transaction, Ledger, Counter, Settings].map((Model) => Model.init())
        );
        await require('../services/merchantWebhookOutboxService').ensureIndexes();
        await Settings.create({ rateLevel3: 5, cashRateLevel3: 5, autoRouteEnabled: false });
        await Counter.create({ name: 'transaction', value: 0 });
        const owners = [];
        for (let index = 0; index < 32; index++) {
            const token = crypto.randomBytes(24).toString('hex');
            const isAgent = index % 2 === 1;
            const Model = isAgent ? User : Company;
            const account = await Model.create({
                name: 'Synthetic audit wallet ' + index,
                status: 'active',
                tier: 3,
                balance: 10000000,
                integrationAccess: { apiEnabled: true },
                ...(isAgent
                    ? {
                          role: 'agent',
                          webUsername: 'audit-agent-' + index,
                          webPassword: crypto.randomBytes(16).toString('hex'),
                          apiToken: token,
                      }
                    : { token }),
            });
            owners.push({
                Model,
                id: account._id,
                model: isAgent ? 'User' : 'ClientCompany',
                token,
                initial: account.balance,
            });
        }
        const port = await unusedPort();
        const env = {
            ...cleanEnvironment(),
            NODE_ENV: 'staging',
            APP_ENV: 'staging',
            ENVIRONMENT: 'staging',
            DOTENV_CONFIG_PATH: path.join(temp, 'absent.env'),
            MONGO_URI: uri,
            REDIS_URL: 'redis://:' + redisPassword + '@127.0.0.1:' + redisPort,
            REDIS_REQUIRED: 'true',
            REDIS_ENABLED: 'true',
            MONGO_TRANSACTIONS_REQUIRED: 'true',
            PORT: String(port),
            HTTP_BIND_HOST: '127.0.0.1',
            SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
            JWT_SECRET: crypto.randomBytes(32).toString('hex'),
            JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
            OTP_SECRET: crypto.randomBytes(32).toString('hex'),
            RUNTIME_ROLE: 'full',
            SESSION_STORE: 'mongo',
            SECURE_COOKIE: 'false',
            MERCHANT_WEBHOOK_WORKER_ENABLED: 'false',
            EXTERNAL_API_ENABLED: 'false',
            BULLMQ_WORKERS_ENABLED: 'false',
            FINANCIAL_SCHEDULERS_ENABLED: 'false',
            LOG_LEVEL: 'error',
            TRUST_PROXY: 'false',
            GLOBAL_RATE_LIMIT_MAX: '1000000',
            HTTP_ALLOWED_ORIGINS: 'http://127.0.0.1:' + port,
        };
        appProcess = fork(__filename, ['--worker'], {
            cwd: root,
            env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        appProcess.stdout.pipe(log, { end: false });
        appProcess.stderr.pipe(log, { end: false });
        appProcess.on('message', (value) => {
            if (value.type === 'sample')
                report.samples.push({ at: new Date().toISOString(), stage: activeStage, ...value });
        });
        appProcess.on('exit', (code, signal) => {
            report.appExit = { code, signal, at: new Date().toISOString() };
        });
        const base = 'http://127.0.0.1:' + port;
        for (let attempt = 0; ; attempt++) {
            try {
                const ready = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(2000) });
                const state = await ready.json();
                if (ready.ok && state.startupReady && state.pid === appProcess.pid) break;
            } catch (_) {}
            if (appProcess.exitCode !== null || appProcess.signalCode !== null || attempt >= 120)
                throw new Error('AUDIT_APP_STARTUP_FAILED');
            await sleep(500);
        }
        let sequence = 0;
        const outcomes = [];
        const request = async () => {
            const index = sequence++;
            const owner = owners[index % owners.length];
            const mode = index % 10;
            const transfer = mode < 6;
            const target = transfer ? '/transfer' : mode < 9 ? '/rates' : '/balance';
            const started = performance.now();
            try {
                const response = await fetch(base + '/api/v1/merchant' + target, {
                    method: transfer ? 'POST' : 'GET',
                    signal: AbortSignal.timeout(25000),
                    headers: {
                        'x-api-key': owner.token,
                        ...(transfer
                            ? { 'Content-Type': 'application/json', 'Idempotency-Key': runId + '-' + index }
                            : {}),
                    },
                    ...(transfer
                        ? {
                              body: JSON.stringify({
                                  target_number: String(1000000000 + index).padStart(11, '0'),
                                  amount: 100,
                                  transfer_type: 'vodafone',
                              }),
                          }
                        : {}),
                });
                const payload = await response.json();
                const result = {
                    index,
                    ownerIndex: index % owners.length,
                    path: target,
                    transactionId: payload.data?.transaction_id || null,
                    status: response.status,
                    code: payload.code || payload.status,
                    ok: response.ok && payload.status === 'success',
                    transfer,
                    ms: performance.now() - started,
                };
                outcomes.push(result);
                return result;
            } catch (error) {
                const result = {
                    index,
                    ownerIndex: index % owners.length,
                    path: target,
                    status: 0,
                    code: error.name,
                    ok: false,
                    transfer,
                    ms: performance.now() - started,
                };
                outcomes.push(result);
                return result;
            }
        };
        for (let index = 0; index < 10; index++) await request();
        for (const concurrency of steps) {
            activeStage = concurrency;
            const started = performance.now(),
                results = [];
            await Promise.all(
                Array.from({ length: concurrency }, async () => {
                    while (
                        performance.now() - started < seconds * 1000 &&
                        appProcess.exitCode === null &&
                        appProcess.signalCode === null
                    ) {
                        results.push(await request());
                    }
                })
            );
            const elapsedSeconds = (performance.now() - started) / 1000;
            const failed = results.filter((result) => !result.ok);
            const infrastructureErrors = failed.filter(
                (result) => result.status === 0 || result.status >= 500
            );
            const codes = {};
            for (const result of results) {
                const key = String(result.status) + '/' + String(result.code);
                codes[key] = (codes[key] || 0) + 1;
            }
            const stage = {
                concurrency,
                requests: results.length,
                elapsedSeconds,
                success: results.length - failed.length,
                acceptedTransfers: results.filter((result) => result.ok && result.transfer).length,
                requestsPerSecond: results.length / elapsedSeconds,
                p50Ms: percentile(
                    results.map((result) => result.ms),
                    0.5
                ),
                p95Ms: percentile(
                    results.map((result) => result.ms),
                    0.95
                ),
                p99Ms: percentile(
                    results.map((result) => result.ms),
                    0.99
                ),
                codes,
                infrastructureErrorFraction: infrastructureErrors.length / Math.max(1, results.length),
            };
            stage.paths = {};
            for (const target of ['/transfer', '/rates', '/balance']) {
                const subset = results.filter((result) => result.path === target);
                stage.paths[target.slice(1)] = {
                    requests: subset.length,
                    successful: subset.filter((result) => result.ok).length,
                    successfulPerSecond: subset.filter((result) => result.ok).length / elapsedSeconds,
                    p95Ms: percentile(
                        subset.map((result) => result.ms),
                        0.95
                    ),
                };
            }
            report.stages.push(stage);
            console.log(JSON.stringify(stage));
            save();
            stage.passed =
                stage.infrastructureErrorFraction <= 0.02 &&
                stage.paths.transfer.successful > 0 &&
                stage.paths.transfer.p95Ms <= 10000 &&
                appProcess.exitCode === null &&
                appProcess.signalCode === null &&
                !(report.samples.at(-1)?.rssMiB > 1536);
            if (!stage.passed) {
                report.stopReason = 'First tested infrastructure/latency/process/memory threshold breach';
                break;
            }
            await sleep(500);
        }
        activeStage = 'drain';
        const drainStarted = Date.now();
        let previousCount = -1,
            stable = 0;
        for (let attempt = 0; attempt < 30 && stable < 5; attempt++) {
            const count = await Transaction.countDocuments({});
            const sample = report.samples.at(-1);
            const idle = sample?.activeRequests === 0 && new Date(sample.at).getTime() >= drainStarted;
            stable = count === previousCount && idle ? stable + 1 : 0;
            previousCount = count;
            await sleep(1000);
        }
        if (stable < 5) throw new Error('AUDIT_DRAIN_DID_NOT_STABILIZE');
        report.invariants = {
            accountCount: owners.length,
            transactions: await Transaction.countDocuments({}),
            ledgerRows: await Ledger.countDocuments({}),
            mismatches: [],
        };
        for (const owner of owners) {
            const [account, sums] = await Promise.all([
                owner.Model.findById(owner.id).lean(),
                Ledger.aggregate([
                    { $match: { entityId: owner.id } },
                    { $group: { _id: null, delta: { $sum: '$amount' }, count: { $sum: 1 } } },
                ]),
            ]);
            const expected = owner.initial + (sums[0]?.delta || 0);
            if (Math.abs(account.balance - expected) > 0.001 || account.balance < 0) {
                report.invariants.mismatches.push({
                    account: String(owner.id),
                    expected,
                    actual: account.balance,
                });
            }
        }
        const transactions = await Transaction.find({}).select('+idempotencyKey').lean();
        const ledgers = await Ledger.find({}).lean();
        const byReference = new Map();
        for (const ledger of ledgers) {
            const rows = byReference.get(ledger.transactionId) || [];
            rows.push(ledger);
            byReference.set(ledger.transactionId, rows);
        }
        const committedIds = new Set(transactions.map((tx) => String(tx._id)));
        const byId = new Map(transactions.map((tx) => [String(tx._id), tx]));
        const references = new Set(),
            keys = new Set();
        for (const tx of transactions) {
            const rows = byReference.get(tx.customId) || [];
            const owner = owners.find((item) => String(item.id) === String(tx.clientActorId));
            if (
                !owner ||
                rows.length !== 1 ||
                String(rows[0]?.entityId) !== String(owner.id) ||
                rows[0]?.entityModel !== owner.model ||
                rows[0]?.type !== 'TRANSFER' ||
                rows[0]?.settledCurrency !== 'LYD' ||
                rows[0]?.amount !== -20 ||
                tx.amount !== 100 ||
                tx.exchangeRate !== 5 ||
                tx.costLYD !== 20 ||
                references.has(tx.customId) ||
                !tx.idempotencyKey ||
                keys.has(tx.idempotencyKey)
            ) {
                report.invariants.mismatches.push({
                    transaction: String(tx._id),
                    reason: 'Transfer/ledger ownership, amount or uniqueness mismatch',
                });
            }
            references.add(tx.customId);
            keys.add(tx.idempotencyKey);
        }
        const successfulTransfers = outcomes.filter((item) => item.transfer && item.ok);
        for (const item of successfulTransfers) {
            if (!committedIds.has(String(item.transactionId)))
                report.invariants.mismatches.push({
                    request: item.index,
                    reason: 'Acknowledged transfer missing from database',
                });
            const tx = byId.get(String(item.transactionId));
            if (
                String(tx?.clientActorId) !== String(owners[item.ownerIndex].id) ||
                tx?.vodafoneNumber !== String(1000000000 + item.index).padStart(11, '0')
            ) {
                report.invariants.mismatches.push({
                    request: item.index,
                    reason: 'Acknowledged transfer owner or recipient differs from request',
                });
            }
        }
        report.uncertainRequests = outcomes
            .filter((item) => item.transfer && !item.ok)
            .map((item) => {
                const owner = owners[item.ownerIndex];
                const key =
                    'merchant-api:' +
                    crypto
                        .createHash('sha256')
                        .update(
                            JSON.stringify([
                                'merchant-api:' + owner.model,
                                String(owner.id),
                                '',
                                runId + '-' + item.index,
                            ])
                        )
                        .digest('hex');
                return {
                    request: item.index,
                    status: item.status,
                    code: item.code,
                    committed: keys.has(key),
                };
            });
        report.invariants.successfulTransferResponses = successfulTransfers.length;
        report.invariants.unacknowledgedCommittedTransfers = transactions.length - successfulTransfers.length;
        report.invariants.passed =
            report.invariants.mismatches.length === 0 &&
            report.invariants.transactions > 0 &&
            successfulTransfers.length > 0 &&
            report.invariants.transactions === report.invariants.ledgerRows;
        report.completedAt = new Date().toISOString();
        report.highestTestedConcurrency = report.stages.at(-1)?.concurrency;
        report.highestPassingConcurrency = report.stages.filter((stage) => stage.passed).at(-1)?.concurrency;
        report.requests = outcomes;
        save();
        if (!report.invariants.passed) throw new Error('AUDIT_FINANCIAL_INVARIANT_FAILED');
    } catch (error) {
        report.error = error.message;
        save();
        throw error;
    } finally {
        if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
            appProcess.kill();
            await new Promise((resolve) => appProcess.once('exit', resolve));
        }
        if (redis) {
            if (
                redisOwned &&
                Number((await redis.info('server').catch(() => '')).match(/process_id:(\d+)/)?.[1]) ===
                    redisProcess.pid
            ) {
                await redis.call('SHUTDOWN', 'NOSAVE').catch(() => {});
            }
            redis.disconnect();
        }
        if (redisProcess && redisProcess.exitCode === null) redisProcess.kill();
        await mongoose.disconnect();
        await replica?.stop();
        if (log) log.end();
        const relative = path.relative(os.tmpdir(), path.resolve(temp));
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
            fs.rmSync(temp, { recursive: true, force: true });
    }
};

if (require.main === module) {
    if (process.argv.includes('--worker')) worker();
    else
        main().catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}
module.exports = { localUri, localRedisUri };
