'use strict';

/**
 * Read-only financial safety checks for Staging or Production.
 *
 * Does not modify .env, MongoDB documents, indexes, or balances.
 * Does not restart any process.
 * The only non-read is a Redis probe key locks:financial-safety-readonly-probe,
 * created with a 5 second TTL and released immediately. It is not a balance,
 * ledger row, audit row, or index.
 *
 * Working directory: the application root that contains this script and .env.
 * Required Node: major version 22 (review environment used v22.14.0).
 * Permissions: filesystem read of the app directory, HTTP read of /health,
 * and a MongoDB user that can read and run hello. Administrator is not required.
 *
 *   node scripts/financialSafetyReadOnlyCheck.js --env staging --required-sha <SHA> --env-file .env --base-url http://127.0.0.1:3000
 *   node scripts/financialSafetyReadOnlyCheck.js --env production --required-sha <SHA> --env-file .env --base-url http://127.0.0.1:3000
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const http = require('http');
const https = require('https');

const mongoose = require('mongoose');

mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);

const PROBE_LOCK_KEY = 'locks:financial-safety-readonly-probe';

const maskText = (value) => String(value || '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]*@)/gi, '$1***@')
    .replace(/(password|passwd|token|secret|authorization|cookie|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=***');

const parseArgs = (argv) => {
    const args = {
        env: '',
        requiredSha: '',
        envFile: '.env',
        baseUrl: 'http://127.0.0.1:3000',
        evidenceDir: path.join('evidence', 'financial-safety')
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--apply') args.applyForbidden = true;
        else if (token === '--env') args.env = argv[++index] || '';
        else if (token === '--required-sha') args.requiredSha = argv[++index] || '';
        else if (token === '--env-file') args.envFile = argv[++index] || '';
        else if (token === '--base-url') args.baseUrl = argv[++index] || '';
        else if (token === '--evidence-dir') args.evidenceDir = argv[++index] || args.evidenceDir;
    }
    return args;
};

const stamp = () => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

const writeEvidence = (dir, envName, check, body) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp()}-${envName}-${check}.json`);
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
};

const record = (checks, name, pass, reason, details) => {
    const item = {
        name,
        result: pass ? 'PASS' : 'FAIL',
        reason: pass ? '' : maskText(reason),
        details: details || {}
    };
    checks.push(item);
    const suffix = pass ? '' : ` ${item.reason}`;
    console.log(`CHECK ${name} ${item.result}${suffix}`);
    return item;
};

const gitOutput = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const requestJson = (url) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            body += chunk;
            if (body.length > 20000) res.destroy();
        });
        res.on('end', () => {
            try {
                resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
            } catch (error) {
                reject(new Error(`invalid JSON from ${target.pathname}`));
            }
        });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${target.pathname}`)));
    req.on('error', reject);
});

const checkGit = (requiredSha) => {
    const head = gitOutput(['rev-parse', 'HEAD']);
    const dirty = gitOutput(['status', '--porcelain']);
    const same = head === requiredSha;
    const clean = dirty.length === 0;
    return {
        pass: same && clean,
        reason: !same ? `HEAD ${head} differs from required ${requiredSha}` : 'working tree is not clean',
        details: { head, requiredSha, clean }
    };
};

const checkNode = () => {
    const version = process.version;
    const pass = /^v22\./.test(version);
    return { pass, reason: `Node ${version} is not major version 22`, details: { version, requiredMajor: 22 } };
};

const checkHealth = async (baseUrl, pathname) => {
    const response = await requestJson(new URL(pathname, baseUrl).toString());
    const status = response.body && response.body.status;
    const pass = response.statusCode === 200 && status === 'ok';
    const details = pathname === '/health'
        ? { http: response.statusCode, status }
        : {
            http: response.statusCode,
            status,
            db: response.body && response.body.db,
            redis: response.body && response.body.redis
        };
    return { pass, reason: `http ${response.statusCode} status ${status || 'missing'}`, details };
};

const checkMongo = async () => {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const build = await mongoose.connection.db.admin().command({ buildInfo: 1 });
    const capable = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    return {
        pass: capable,
        reason: 'MongoDB is not a replica set or sharded cluster',
        details: {
            version: build.version,
            setName: hello.setName || '',
            msg: hello.msg || '',
            transactionsCapable: capable
        }
    };
};

const checkRedis = async () => {
    const Redis = require('ioredis');
    const url = process.env.REDIS_URL || process.env.REDIS_URI;
    if (!url) return { pass: false, reason: 'REDIS_URL and REDIS_URI are ABSENT', details: { configured: false } };
    const client = new Redis(url, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        lazyConnect: true,
        retryStrategy: () => null
    });
    client.on('error', () => {});
    try {
        await client.connect();
        const pong = await client.ping();
        const info = await client.info('server');
        const version = (String(info).match(/redis_version:([^\r\n]+)/) || [])[1] || '';
        const RedlockClass = require('redlock').default || require('redlock');
        const redlock = new RedlockClass([client], { retryCount: 2, retryDelay: 100, retryJitter: 0 });
        const lock = await redlock.acquire([PROBE_LOCK_KEY], 5000);
        await lock.release();
        return {
            pass: pong === 'PONG',
            reason: `PING returned ${pong}`,
            details: { ping: pong, redisVersion: version, redlockProbe: 'released', probeKey: PROBE_LOCK_KEY }
        };
    } finally {
        await client.quit().catch(() => {});
    }
};

const checkReconciliation = async () => {
    const db = mongoose.connection.db;
    const specs = [
        ['users', 'User'],
        ['clientcompanies', 'ClientCompany'],
        ['subaccounts', 'SubAccount']
    ];
    let entityGaps = 0;
    let netGap = 0;
    for (const [coll, model] of specs) {
        const ledger = new Map();
        const grouped = db.collection('ledgers').aggregate([
            { $match: { entityModel: model } },
            { $group: { _id: '$entityId', sum: { $sum: '$amount' } } }
        ]);
        for await (const row of grouped) ledger.set(String(row._id), Number(row.sum || 0));
        const accounts = db.collection(coll).find({}, { projection: { balance: 1 } });
        for await (const doc of accounts) {
            const gap = Number(doc.balance || 0) - Number(ledger.get(String(doc._id)) || 0);
            if (gap !== 0) {
                entityGaps += 1;
                netGap += gap;
            }
        }
    }
    const broken = await db.collection('ledgers').aggregate([
        { $match: { transactionId: /^BTR-/ } },
        { $group: { _id: '$transactionId', net: { $sum: '$amount' } } },
        { $match: { net: { $ne: 0 } } },
        { $count: 'n' }
    ]).toArray();
    const internalTransfersNotZero = (broken[0] && broken[0].n) || 0;
    const pass = entityGaps === 0 && internalTransfersNotZero === 0;
    return {
        pass,
        reason: `entityGaps=${entityGaps} netGap=${netGap} internalTransfersNotZero=${internalTransfersNotZero}`,
        details: { entityGaps, netGap, internalTransfersNotZero }
    };
};

const checkBackfill = async () => {
    const { runBackfill } = require('./backfillFinancialTenantId');
    const report = await runBackfill({
        apply: false,
        checkpointFile: null,
        User: require('../models/User'),
        ClientCompany: require('../models/ClientCompany'),
        SubAccount: require('../models/SubAccount'),
        Transaction: require('../models/Transaction'),
        Ledger: require('../models/Ledger'),
        JournalEvent: require('../models/JournalEvent'),
        AuditLog: require('../models/AuditLog')
    });
    const counts = {};
    let undetermined = 0;
    for (const name of ['Transaction', 'Ledger', 'JournalEvent', 'AuditLog']) {
        const summary = report.collections[name].summary;
        counts[name] = {
            determined: summary.confident,
            legacy: summary.unresolvable,
            ambiguous: summary.ambiguous,
            modified: summary.modified
        };
        undetermined += summary.ambiguous + summary.unresolvable;
        if (summary.modified !== 0) undetermined += 1;
    }
    return {
        pass: undetermined === 0 && report.mode === 'dry-run',
        reason: `undetermined=${undetermined} mode=${report.mode}`,
        details: { mode: report.mode, unchangedFields: report.unchangedFields, counts }
    };
};

const checkAccountCodes = async () => {
    const { runPrepare } = require('./prepareAccountCodeTenantIndex');
    const report = await runPrepare({
        apply: false,
        allowIndex: false,
        AccountCode: require('../models/AccountCode'),
        User: require('../models/User'),
        ClientCompany: require('../models/ClientCompany'),
        SubAccount: require('../models/SubAccount')
    });
    const pass = report.mode === 'scan' && report.indexCreated === false && report.duplicates === 0;
    return {
        pass,
        reason: `mode=${report.mode} indexCreated=${report.indexCreated} duplicates=${report.duplicates}`,
        details: {
            mode: report.mode,
            indexCreated: report.indexCreated,
            duplicates: report.duplicates
        }
    };
};

const checkAuditLog = async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'models', 'AuditLog.js'), 'utf8');
    const guardsPresent = source.includes('installAppendOnlyGuards(auditLogSchema');
    const indexes = await mongoose.connection.db.collection('auditlogs').indexes();
    const ttl = indexes.filter((index) => Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds'));
    const pass = guardsPresent && ttl.length === 0;
    return {
        pass,
        reason: !guardsPresent ? 'installAppendOnlyGuards is missing from models/AuditLog.js' : 'auditlogs has a TTL index',
        details: {
            guardsPresent,
            ttlIndexes: ttl.length,
            indexNames: indexes.map((index) => index.name)
        }
    };
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    const checks = [];
    if (args.applyForbidden) {
        record(checks, 'readonly', false, '--apply is refused. This command never writes.');
        process.exitCode = 2;
        return;
    }
    if (!['staging', 'production'].includes(args.env)) {
        record(checks, 'arguments', false, '--env must be staging or production');
        process.exitCode = 2;
        return;
    }
    if (!/^[0-9a-f]{40}$/i.test(args.requiredSha)) {
        record(checks, 'arguments', false, '--required-sha must be a 40 character git SHA');
        process.exitCode = 2;
        return;
    }

    require('dotenv').config({ path: args.envFile });
    const node = checkNode();
    record(checks, 'node-version', node.pass, node.reason, node.details);
    try {
        const git = checkGit(args.requiredSha);
        record(checks, 'git-sha', git.pass, git.reason, git.details);
    } catch (error) {
        record(checks, 'git-sha', false, error.message);
    }

    for (const pathname of ['/health', '/health/ready']) {
        const name = pathname === '/health' ? 'health' : 'health-ready';
        try {
            const health = await checkHealth(args.baseUrl, pathname);
            record(checks, name, health.pass, health.reason, health.details);
        } catch (error) {
            record(checks, name, false, error.message);
        }
    }

    const mongoUri = String(process.env.MONGO_URI || '').trim();
    if (!mongoUri || mongoUri.toLowerCase() === 'demo') {
        record(checks, 'mongo-replica', false, 'MONGO_URI is ABSENT');
        record(checks, 'reconciliation', false, 'MONGO_URI is ABSENT');
        record(checks, 'tenant-backfill-dry-run', false, 'MONGO_URI is ABSENT');
        record(checks, 'account-code-duplicates', false, 'MONGO_URI is ABSENT');
        record(checks, 'auditlog-write-path', false, 'MONGO_URI is ABSENT');
    } else {
        try {
            await mongoose.connect(mongoUri, {
                autoIndex: false,
                autoCreate: false,
                serverSelectionTimeoutMS: 8000
            });
            const steps = [
                ['mongo-replica', checkMongo],
                ['reconciliation', checkReconciliation],
                ['tenant-backfill-dry-run', checkBackfill],
                ['account-code-duplicates', checkAccountCodes],
                ['auditlog-write-path', checkAuditLog]
            ];
            for (const [name, fn] of steps) {
                try {
                    const outcome = await fn();
                    record(checks, name, outcome.pass, outcome.reason, outcome.details);
                } catch (error) {
                    record(checks, name, false, error.message);
                }
            }
        } catch (error) {
            record(checks, 'mongo-replica', false, error.message);
        } finally {
            await mongoose.disconnect().catch(() => {});
        }
    }

    try {
        const redis = await checkRedis();
        record(checks, 'redis-redlock', redis.pass, redis.reason, redis.details);
    } catch (error) {
        record(checks, 'redis-redlock', false, error.message);
    }

    const failed = checks.some((item) => item.result === 'FAIL');
    const evidence = writeEvidence(args.evidenceDir, args.env, 'summary', {
        env: args.env,
        readOnly: true,
        serviceRestarted: false,
        indexCreated: false,
        balancesWritten: false,
        result: failed ? 'FAIL' : 'PASS',
        checks
    });
    console.log(`EVIDENCE ${evidence}`);
    console.log(`RESULT ${failed ? 'FAIL' : 'PASS'}`);
    process.exitCode = failed ? 1 : 0;
};

if (require.main === module) {
    main().catch((error) => {
        console.log(`CHECK runner FAIL ${maskText(error.message)}`);
        console.log('RESULT FAIL');
        process.exitCode = 1;
    });
}

module.exports = { maskText, parseArgs, PROBE_LOCK_KEY };
