'use strict';

/**
 * Read-only financial safety checks for Staging or Production.
 *
 * Does not modify .env, MongoDB documents, indexes, or balances.
 * Does not restart any process.
 * Default Redis check is PING, INFO server, and Redlock constructor sanity.
 * A lock write happens only with --redis-lock-probe.
 *
 * Run this file from a separate clone. --app-dir is the production or staging
 * folder whose git HEAD is checked. --env-file is that folder's .env, read only.
 * Evidence is written under the clone, never inside --app-dir.
 *
 * Node 18, 20, and 22 are accepted. Any other major version fails as NODE_VERSION.
 * Review tests ran on v22.14.0. Permissions: read the app folder, GET /health,
 * and a MongoDB read user that can run hello. Administrator is not required.
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
        appDir: '',
        baseUrl: 'http://127.0.0.1:3000',
        evidenceDir: path.join('evidence', 'financial-safety'),
        redisLockProbe: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--apply') args.applyForbidden = true;
        else if (token === '--redis-lock-probe') args.redisLockProbe = true;
        else if (token === '--env') args.env = argv[++index] || '';
        else if (token === '--required-sha') args.requiredSha = argv[++index] || '';
        else if (token === '--env-file') args.envFile = argv[++index] || '';
        else if (token === '--app-dir') args.appDir = argv[++index] || '';
        else if (token === '--base-url') args.baseUrl = argv[++index] || '';
        else if (token === '--evidence-dir') args.evidenceDir = argv[++index] || args.evidenceDir;
    }
    return args;
};

const ACCEPTED_NODE_MAJORS = [18, 20, 22];

const assessNodeVersion = (version) => {
    const major = Number(String(version || '').replace(/^v/, '').split('.')[0]);
    const pass = ACCEPTED_NODE_MAJORS.includes(major);
    return {
        pass,
        reason: `NODE_VERSION ${version} is not 18, 20, or 22`,
        details: { version, acceptedMajors: ACCEPTED_NODE_MAJORS }
    };
};

const gitRevParseArgs = (appDir) => ['-C', appDir, 'rev-parse', 'HEAD'];
const gitStatusArgs = (appDir) => ['-C', appDir, 'status', '--porcelain'];

const evidenceInsideApp = (evidenceDir, appDir) => {
    const evidenceRoot = path.resolve(evidenceDir);
    const appRoot = path.resolve(appDir);
    return evidenceRoot === appRoot || evidenceRoot.startsWith(appRoot + path.sep);
};

const classifyBalanceGap = (balance, ledgerCount, ledgerSum) => {
    const gap = Number(balance || 0) - Number(ledgerSum || 0);
    if (gap === 0) return null;
    if (Number(ledgerCount || 0) === 0) return { className: 'opening_balance_no_ledger', amount: gap };
    return { className: 'other', amount: gap };
};

const emptyGapClass = () => ({ count: 0, signedGapTotal: 0, absoluteGapTotal: 0 });

const addGap = (classes, gap) => {
    const bucket = classes[gap.className];
    bucket.count += 1;
    bucket.signedGapTotal += gap.amount;
    bucket.absoluteGapTotal += Math.abs(gap.amount);
};

const resolveTenantMode = (env) => {
    const raw = String((env && env.TENANT_MODE) || '').trim().toLowerCase();
    if (!raw) return { mode: 'single', source: 'unset-default-single' };
    if (raw === 'multi') return { mode: 'multi', source: 'env' };
    return { mode: 'single', source: 'env' };
};

const summarizeTenantCounts = (summary, mode) => ({
    determined: summary.confident || 0,
    ambiguous: summary.ambiguous || 0,
    legacy: mode === 'multi' ? (summary.unresolvable || 0) : 0,
    legacy_single_tenant_assignable: mode === 'single' ? (summary.unresolvable || 0) : 0,
    modified: summary.modified || 0
});

const tenantCountsFail = (counts, mode) => (
    counts.modified !== 0
    || counts.ambiguous > 0
    || (mode === 'multi' && counts.legacy > 0)
);

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

const checkGit = (requiredSha, appDir) => {
    const head = gitOutput(gitRevParseArgs(appDir));
    const dirty = gitOutput(gitStatusArgs(appDir));
    const dirtyCount = dirty ? dirty.split(/\r?\n/).filter(Boolean).length : 0;
    const same = head === requiredSha;
    const clean = dirtyCount === 0;
    return {
        pass: same && clean,
        reason: !same ? `HEAD ${head} differs from required ${requiredSha}` : 'working tree is not clean',
        details: { appDir, head, requiredSha, dirtyCount, clean }
    };
};

const checkNode = () => assessNodeVersion(process.version);

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

const checkRedis = async (lockProbe) => {
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
        const redlockOptions = { driftFactor: 0.01, retryCount: 2, retryDelay: 100, retryJitter: 0 };
        const redlock = new RedlockClass([client], redlockOptions);
        const configSane = typeof redlock.acquire === 'function'
            && redlockOptions.driftFactor > 0
            && redlockOptions.driftFactor < 1;
        let redlockProbe = 'not-run';
        if (lockProbe) {
            const lock = await redlock.acquire([PROBE_LOCK_KEY], 5000);
            await lock.release();
            redlockProbe = 'released';
        }
        return {
            pass: pong === 'PONG' && configSane,
            reason: pong !== 'PONG' ? `PING returned ${pong}` : 'Redlock constructor is not usable',
            details: { ping: pong, redisVersion: version, redlockProbe, redisLockProbe: Boolean(lockProbe) }
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
    const classes = {
        opening_balance_no_ledger: emptyGapClass(),
        other: emptyGapClass()
    };
    for (const [coll, model] of specs) {
        const ledger = new Map();
        const grouped = db.collection('ledgers').aggregate([
            { $match: { entityModel: model } },
            { $group: { _id: '$entityId', sum: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]);
        for await (const row of grouped) {
            ledger.set(String(row._id), { sum: Number(row.sum || 0), count: Number(row.count || 0) });
        }
        const accounts = db.collection(coll).find({}, { projection: { balance: 1 } });
        for await (const doc of accounts) {
            const entry = ledger.get(String(doc._id)) || { sum: 0, count: 0 };
            const gap = classifyBalanceGap(doc.balance, entry.count, entry.sum);
            if (!gap) continue;
            entityGaps += 1;
            netGap += gap.amount;
            addGap(classes, gap);
        }
    }
    const broken = await db.collection('ledgers').aggregate([
        { $match: { transactionId: /^BTR-/ } },
        { $group: { _id: '$transactionId', net: { $sum: '$amount' } } },
        { $match: { net: { $ne: 0 } } },
        { $group: { _id: null, n: { $sum: 1 }, absoluteNet: { $sum: { $abs: '$net' } } } }
    ]).toArray();
    const internalTransfersNotZero = (broken[0] && broken[0].n) || 0;
    const internalTransferAbsoluteNet = (broken[0] && broken[0].absoluteNet) || 0;
    const pass = entityGaps === 0 && internalTransfersNotZero === 0;
    return {
        pass,
        reason: `entityGaps=${entityGaps} openingBalanceNoLedger=${classes.opening_balance_no_ledger.count} other=${classes.other.count} internalTransfersNotZero=${internalTransfersNotZero}`,
        details: {
            entityGaps,
            netGap,
            opening_balance_no_ledger: classes.opening_balance_no_ledger,
            other: classes.other,
            internalTransfersNotZero,
            internalTransferAbsoluteNet
        }
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
    const tenant = resolveTenantMode(process.env);
    const counts = {};
    let stop = report.mode !== 'dry-run';
    for (const name of ['Transaction', 'Ledger', 'JournalEvent', 'AuditLog']) {
        counts[name] = summarizeTenantCounts(report.collections[name].summary, tenant.mode);
        if (tenantCountsFail(counts[name], tenant.mode)) stop = true;
    }
    return {
        pass: !stop,
        reason: `tenantMode=${tenant.mode} source=${tenant.source} ambiguous=${Object.values(counts).reduce((sum, row) => sum + row.ambiguous, 0)} legacy=${Object.values(counts).reduce((sum, row) => sum + row.legacy, 0)}`,
        details: { mode: report.mode, tenantMode: tenant.mode, tenantModeSource: tenant.source, unchangedFields: report.unchangedFields, counts }
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
    if (!args.appDir) {
        record(checks, 'arguments', false, '--app-dir is required and must be the application folder, not this check clone');
        process.exitCode = 2;
        return;
    }
    if (evidenceInsideApp(args.evidenceDir, args.appDir)) {
        record(checks, 'arguments', false, '--evidence-dir must not be inside --app-dir');
        process.exitCode = 2;
        return;
    }

    require('dotenv').config({ path: args.envFile });
    const node = checkNode();
    record(checks, 'node-version', node.pass, node.reason, node.details);
    try {
        const git = checkGit(args.requiredSha, args.appDir);
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
        const redis = await checkRedis(args.redisLockProbe);
        record(checks, 'redis-redlock', redis.pass, redis.reason, redis.details);
    } catch (error) {
        record(checks, 'redis-redlock', false, error.message);
    }

    const failed = checks.some((item) => item.result === 'FAIL');
    const evidence = writeEvidence(args.evidenceDir, args.env, 'summary', {
        env: args.env,
        appDir: args.appDir,
        readOnly: true,
        redisLockProbe: Boolean(args.redisLockProbe),
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

module.exports = {
    maskText,
    parseArgs,
    PROBE_LOCK_KEY,
    assessNodeVersion,
    gitRevParseArgs,
    classifyBalanceGap,
    summarizeTenantCounts,
    tenantCountsFail,
    resolveTenantMode,
    evidenceInsideApp
};
