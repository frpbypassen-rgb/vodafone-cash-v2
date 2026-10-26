'use strict';

// Default: read-only plan. --apply is an explicit operational recovery, not a Payment retry.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execSync, execFileSync } = require('node:child_process');
const { TERMINAL, pristine, summarize, buildRecoveryFence } = require('../services/apiRuntimeRecoveryPolicy');
const cwd = process.cwd();
const apply = process.argv.includes('--apply');
const customId = process.argv[process.argv.indexOf('--transaction') + 1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => {
    throw new Error(message);
};
const pm2 = (command) =>
    execSync('pm2 ' + command, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
const apps = () => JSON.parse(pm2('jlist'));
const managed = () => apps().find((app) => app.name === 'ahram-pay') || fail('PM2_APP_MISSING');
const ps = (command) =>
    execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + command],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 }
    ).trim();
const owners = () =>
    JSON.parse(
        ps(
            'ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)'
        )
    );
const processInfo = (pid) => {
    if (!Number.isInteger(pid) || pid < 1) fail('INVALID_PID');
    return JSON.parse(
        ps(
            `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`
        ) || 'null'
    );
};
let db,
    redis,
    queue,
    locked = false,
    pausedByUs = false,
    fenced = false,
    stopped = false;
let token, originalOwner, daemon, fence, target;
const lockKey = 'ahram:api-runtime-recovery';

function assertOwner() {
    const ids = owners();
    const current = processInfo(originalOwner.ProcessId);
    if (
        ids.length !== 1 ||
        ids[0] !== originalOwner.ProcessId ||
        !current ||
        current.CreationDate !== originalOwner.CreationDate ||
        current.ParentProcessId !== daemon
    )
        fail('PORT_OWNER_CHANGED');
}

async function checkOtherClaims() {
    const count = await db.connection.collection('transactions').countDocuments({
        _id: { $ne: target._id },
        $or: [
            { 'apiResultData.providerDispatchAttemptId': { $exists: true, $ne: null } },
            { 'apiResultData.providerDispatchStartedAt': { $exists: true, $ne: null } },
        ],
        status: { $nin: [...TERMINAL] },
        'apiResultData.providerDispatchResult': { $nin: ['accepted', 'rejected'] },
    });
    if (count) fail('OTHER_PROVIDER_RESULTS_REQUIRE_REVIEW_' + count);
}

async function inspectActive() {
    const jobs = (await queue.getJobs(['active'], 0, -1, false)).filter(Boolean);
    const rows = [];
    for (const job of jobs) {
        if (!db.Types.ObjectId.isValid(String(job.data.txId))) fail('UNKNOWN_ACTIVE_JOB_' + job.id);
        const tx = await db.connection
            .collection('transactions')
            .findOne({ _id: new db.Types.ObjectId(String(job.data.txId)) });
        if (!tx) fail('ACTIVE_JOB_WITHOUT_TRANSACTION_' + job.id);
        if (!TERMINAL.has(tx.status) && String(tx._id) !== String(target._id))
            fail('OTHER_ACTIVE_TRANSACTION_' + tx.customId);
        rows.push({ job: job.asJSON(), transaction: tx, state: summarize(tx) });
    }
    return rows;
}

async function main() {
    if (process.platform !== 'win32') fail('WINDOWS_ONLY');
    if (!/^ATT-\d{4}-\d+$/.test(customId || '')) fail('USE_TRANSACTION_ARGUMENT');
    const app = managed();
    const env = app.pm2_env;
    if (
        path.resolve(env.pm_cwd).toLowerCase() !== cwd.toLowerCase() ||
        path.resolve(env.pm_exec_path).toLowerCase() !== path.join(cwd, 'app.js').toLowerCase()
    )
        fail('WRONG_PROJECT');
    const home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
    daemon = Number(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8').trim());
    const ids = owners();
    if (ids.length !== 1) fail('EXPECTED_ONE_PORT_OWNER');
    originalOwner = processInfo(ids[0]);
    if (
        !originalOwner ||
        originalOwner.ParentProcessId !== daemon ||
        !/ProcessContainerFork\.js/i.test(originalOwner.CommandLine || '')
    )
        fail('UNVERIFIED_PORT_OWNER');
    if (apps().some((row) => row.pid === ids[0] && row.name !== 'ahram-pay'))
        fail('PORT_OWNER_MANAGED_AS_ANOTHER_APP');
    require('dotenv').config({ path: env.DOTENV_CONFIG_PATH || '.env', quiet: true });
    for (const key of ['MONGO_URI', 'REDIS_URL', 'REDIS_URI'])
        if (env[key]) process.env[key] = String(env[key]);
    if (!process.env.MONGO_URI || !(process.env.REDIS_URL || process.env.REDIS_URI))
        fail('DATABASE_CONFIGURATION_MISSING');
    db = require('mongoose');
    await db.connect(process.env.MONGO_URI, {
        autoCreate: false,
        autoIndex: false,
        serverSelectionTimeoutMS: 15000,
    });
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL || process.env.REDIS_URI, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 10000,
        commandTimeout: 15000,
        retryStrategy: () => null,
    });
    redis.on('error', () => {});
    await redis.connect();
    const { Queue } = require('bullmq');
    queue = new Queue('api-transfers-queue', { connection: redis, skipMetasUpdate: true });
    target = await db.connection.collection('transactions').findOne({ customId });
    if (!target || !pristine(target)) fail('TARGET_NOT_PRISTINE_DO_NOT_RESEND');
    if (
        await db.connection.collection('ledgers').countDocuments({
            transactionId: customId,
            entityModel: 'ExecutorGroup',
            type: 'TRANSFER',
            amount: { $lt: 0 },
        })
    )
        fail('TARGET_ALREADY_HAS_A_DEBIT');
    const group = await db.connection.collection('executorgroups').findOne({ _id: target.executorGroupId });
    if (!group || group.status !== 'active' || group.isApiBot !== true) fail('API_PROVIDER_NOT_ACTIVE');
    await checkOtherClaims();
    let rows = await inspectActive();
    console.log(
        'RECOVERY_PLAN:',
        JSON.stringify({
            apply,
            portOwner: originalOwner.ProcessId,
            managedPid: app.pid,
            transaction: customId,
            activeJobs: rows.map((row) => ({ job: row.job.id, ...row.state })),
            queuePaused: await queue.isPaused(),
            financialBalancesWillBeEdited: false,
        })
    );
    if (!apply) return;
    if (!fs.readFileSync(path.join(cwd, 'app.js'), 'utf8').includes('startBoundHttpServer'))
        fail('INSTALL_RUNTIME_PATCH_FIRST');
    if (await queue.isPaused()) fail('QUEUE_ALREADY_PAUSED_REVIEW_FIRST');
    token = 'runtime-recovery-' + crypto.randomUUID();
    if ((await redis.set(lockKey, token, 'PX', 600000, 'NX')) !== 'OK') fail('ANOTHER_RECOVERY_IS_RUNNING');
    locked = true;
    await queue.pause();
    pausedByUs = true;
    console.log('API_QUEUE_PAUSED');
    rows = await inspectActive();
    await checkOtherClaims();
    assertOwner();
    const backupDir = path.join(os.homedir(), 'ahram-recovery', token);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(path.join(home, 'dump.pm2'), path.join(backupDir, 'dump.pm2'));
    fs.writeFileSync(
        path.join(backupDir, 'jobs-and-transactions.json'),
        JSON.stringify({ target, rows, originalOwner }, null, 2)
    );
    console.log('RECOVERY_ARCHIVE:', backupDir);
    fence = buildRecoveryFence(target, token);
    const reserve = await db.connection.collection('transactions').updateOne(fence.filter, fence.update);
    if (reserve.modifiedCount !== 1) fail('PAYMENT_OR_TRANSACTION_CHANGED_RECOVERY_ABORTED');
    fenced = true;
    console.log('TARGET_PAYMENT_FENCED_NO_PAYMENT_SENT_BY_RECOVERY');
    await checkOtherClaims();
    assertOwner();
    stopped = true;
    pm2('stop ahram-pay');
    const existing = processInfo(originalOwner.ProcessId);
    if (existing) {
        assertOwner();
        ps(`Stop-Process -Id ${originalOwner.ProcessId} -ErrorAction Stop`);
    }
    const deadline = Date.now() + 90000;
    while (true) {
        const clients = await queue.getWorkers();
        const jobs = (await queue.getJobs(['active'], 0, -1, false)).filter(Boolean);
        const ttls = await Promise.all(jobs.map((job) => redis.pttl(queue.toKey(job.id) + ':lock')));
        if (!owners().length && !clients.length && ttls.every((ttl) => ttl === -2)) break;
        if (Date.now() > deadline) fail('OLD_WORKERS_OR_LOCKS_STILL_PRESENT');
        await sleep(2000);
    }
    // Remove only terminal transaction jobs and copies of the fenced target.
    const candidates = (
        await queue.getJobs(['active', 'waiting', 'paused', 'delayed', 'failed', 'prioritized'], 0, -1, false)
    ).filter(Boolean);
    const activeIds = new Set(rows.map((row) => String(row.job.id)));
    const remove = candidates.filter(
        (job) => activeIds.has(String(job.id)) || String(job.data.txId) === String(target._id)
    );
    fs.writeFileSync(
        path.join(backupDir, 'jobs-before-removal.json'),
        JSON.stringify(
            remove.map((job) => job.asJSON()),
            null,
            2
        )
    );
    for (const job of remove) {
        const tx = await db.connection
            .collection('transactions')
            .findOne({ _id: new db.Types.ObjectId(String(job.data.txId)) });
        if (String(tx?._id) === String(target._id)) {
            if (!(await db.connection.collection('transactions').findOne(fence.releaseFilter)))
                fail('TARGET_FENCE_CHANGED');
        } else if (!tx || !TERMINAL.has(tx.status)) fail('TRANSACTION_CHANGED_BEFORE_JOB_REMOVAL');
        if (await redis.exists(queue.toKey(job.id) + ':lock')) fail('JOB_IS_STILL_LOCKED');
        await job.remove();
        console.log('ARCHIVED_JOB_REMOVED:', job.id);
    }
    if (await queue.getActiveCount()) fail('UNEXPECTED_ACTIVE_JOB_REMAINS');
    const job = await queue.add(
        'transfer_' + target._id,
        { txId: String(target._id), apiGroupId: String(target.executorGroupId) },
        {
            jobId: token,
            deduplication: { id: `api-transfer-${target._id}-${target.executorGroupId}` },
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: false,
        }
    );
    console.log('ONE_TARGET_JOB_QUEUED:', job.id);
    pm2('restart ahram-pay');
    let ready;
    const readyDeadline = Date.now() + 90000;
    while (Date.now() < readyDeadline) {
        const candidate = managed();
        const currentOwners = owners();
        if (
            candidate.pm2_env.status === 'online' &&
            currentOwners.length === 1 &&
            currentOwners[0] === candidate.pid
        ) {
            try {
                const response = await fetch('http://127.0.0.1:3000/health/ready', {
                    signal: AbortSignal.timeout(5000),
                    redirect: 'error',
                });
                const health = await response.json();
                if (
                    response.ok &&
                    health.status === 'ok' &&
                    health.startupReady === true &&
                    health.pid === candidate.pid
                ) {
                    ready = candidate;
                    break;
                }
            } catch (_) {}
        }
        await sleep(2000);
    }
    if (!ready) fail('NEW_APPLICATION_NOT_READY');
    await sleep(20000);
    const stable = managed();
    const currentOwners = owners();
    if (
        stable.pid !== ready.pid ||
        stable.pm2_env.restart_time !== ready.pm2_env.restart_time ||
        currentOwners.length !== 1 ||
        currentOwners[0] !== stable.pid ||
        (await queue.getWorkers()).length !== 1
    )
        fail('NEW_APPLICATION_NOT_STABLE');
    if (!(await queue.isPaused())) fail('QUEUE_RESUMED_EXTERNALLY');
    await checkOtherClaims();
    pm2('save');
    const released = await db.connection
        .collection('transactions')
        .updateOne(fence.releaseFilter, fence.releaseUpdate);
    if (released.modifiedCount !== 1) fail('TARGET_CHANGED_FENCE_NOT_RELEASED');
    fenced = false;
    await queue.resume();
    pausedByUs = false;
    console.log(
        'API_RUNTIME_RECOVERED:',
        JSON.stringify({
            pid: stable.pid,
            transaction: customId,
            job: job.id,
            apiWorkers: 1,
            queuePaused: await queue.isPaused(),
            balancesEditedByRecovery: false,
            paidTransactionsLeftUnchanged: rows.filter((row) => row.state.reference).map((row) => row.state),
        })
    );
}

main()
    .catch(async (error) => {
        console.error('RECOVERY_STOPPED:', error.code || error.message);
        if (pausedByUs && !fenced && !stopped) {
            try {
                assertOwner();
                await queue.resume();
                pausedByUs = false;
                console.log('ORIGINAL_QUEUE_STATE_RESTORED');
            } catch (_) {}
        }
        if (pausedByUs) console.error('QUEUE_REMAINS_PAUSED_FOR_REVIEW');
        if (fenced) console.error('TARGET_REMAINS_PAYMENT_FENCED_DO_NOT_RESEND');
        process.exitCode = 1;
    })
    .finally(async () => {
        if (locked && redis)
            await redis
                .eval(
                    "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
                    1,
                    lockKey,
                    token
                )
                .catch(() => {});
        if (queue) await queue.close().catch(() => {});
        if (redis) await redis.quit().catch(() => redis.disconnect());
        if (db) await db.disconnect().catch(() => {});
    });
