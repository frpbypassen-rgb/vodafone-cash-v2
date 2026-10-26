'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../services/apiRuntimeRecoveryPolicy');
const source = fs.readFileSync(path.join(__dirname, '../scripts/recoverApiRuntime.js'), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

async function exercise(mode) {
    const effects = [];
    const errors = [];
    let now = 0,
        cut = false,
        started = false,
        paused = false;
    const target = {
        _id: 'target',
        customId: 'ATT-2610-21779',
        status: mode === 'paid-target' ? 'completed' : 'processing',
        executorGroupId: 'group',
        apiResultData: {},
    };
    const paid = {
        _id: 'paid',
        customId: 'ATT-2610-21766',
        status: 'completed',
        executorGroupId: 'group',
        apiResultData: { referenceNumber: 'ref', providerDispatchResult: 'accepted', ledgerPosted: false },
    };
    const paidBefore = clone(paid);
    const documents = [target, paid];
    if (mode === 'other-active')
        documents.push({ _id: 'other', customId: 'ATT-2610-99999', status: 'processing' });
    const removed = new Set();
    const jobs = documents.map((tx, index) => ({
        id: String(index + 1),
        data: { txId: tx._id },
        asJSON() {
            return { id: this.id, data: this.data };
        },
        async remove() {
            effects.push('remove:' + this.id);
            removed.add(this.id);
        },
    }));
    const matches = (doc, filter) =>
        Object.entries(filter).every(([key, value]) => {
            if (key === 'apiResultData' && value?.$exists === false)
                return !Object.prototype.hasOwnProperty.call(doc, key);
            if (key === '_id' || key === 'executorGroupId') return String(doc[key]) === String(value);
            return JSON.stringify(doc[key]) === JSON.stringify(value);
        });
    const mongo = {
        async connect() {},
        async disconnect() {},
        Types: {
            ObjectId: class {
                constructor(value) {
                    this.value = value;
                }
                toString() {
                    return this.value;
                }
                static isValid() {
                    return true;
                }
            },
        },
        connection: {
            collection(name) {
                if (name === 'ledgers') return { countDocuments: async () => 0 };
                if (name === 'executorgroups')
                    return { findOne: async () => ({ status: 'active', isApiBot: true }) };
                if (name !== 'transactions') throw new Error('UNEXPECTED_COLLECTION');
                return {
                    countDocuments: async () => (mode === 'other-claim' ? 1 : 0),
                    findOne: async (filter) => {
                        const doc = documents.find((row) => matches(row, filter));
                        return doc ? clone(doc) : null;
                    },
                    updateOne: async (filter, update) => {
                        const reserving = Boolean(update.$set?.apiResultData?.runtimeRecoveryFence);
                        if (mode === 'claim-race' && reserving)
                            target.apiResultData = { providerDispatchAttemptId: 'real-payment-claim' };
                        if (mode === 'release-conflict' && !reserving)
                            target.apiResultData.operatorNote = 'new-evidence';
                        if (!matches(target, filter)) return { modifiedCount: 0 };
                        effects.push(reserving ? 'fence' : 'release');
                        if (update.$set) Object.assign(target, clone(update.$set));
                        if (update.$unset) for (const key of Object.keys(update.$unset)) delete target[key];
                        return { modifiedCount: 1 };
                    },
                };
            },
        },
    };
    const queue = {
        toKey: (id) => 'bull:api-transfers-queue:' + id,
        async isPaused() {
            return paused;
        },
        async pause() {
            paused = true;
            effects.push('pause');
        },
        async resume() {
            paused = false;
            effects.push('resume');
        },
        async getJobs() {
            return jobs.filter((job) => !removed.has(job.id));
        },
        async getActiveCount() {
            return jobs.filter((job) => !removed.has(job.id)).length;
        },
        async getWorkers() {
            return started ? Array(mode === 'two-workers' ? 2 : 1).fill({}) : cut ? [] : [{}];
        },
        async add(name, data, options) {
            effects.push('enqueue');
            expect(data.txId).toBe('target');
            expect(options.attempts).toBe(1);
            return { id: options.jobId };
        },
        async close() {},
    };
    class Redis {
        on() {}
        async connect() {}
        async quit() {}
        disconnect() {}
        async set() {
            return 'OK';
        }
        async eval() {
            return 1;
        }
        async pttl() {
            return cut ? -2 : 25000;
        }
        async exists() {
            return cut ? 0 : 1;
        }
    }
    const app = () => ({
        name: 'ahram-pay',
        pid: started ? 5000 : 8180,
        pm2_env: {
            status: 'online',
            restart_time: 3,
            pm_cwd: '/project',
            pm_exec_path: '/project/app.js',
            MONGO_URI: 'mongodb://test/db',
            REDIS_URL: 'redis://test',
        },
    });
    const owner = {
        ProcessId: 30400,
        ParentProcessId: mode === 'wrong-owner' ? 1 : 33564,
        CreationDate: 'fixed',
        CommandLine: 'node ProcessContainerFork.js',
    };
    const cp = {
        execSync(command) {
            if (command === 'pm2 jlist') return JSON.stringify([app()]);
            effects.push(command);
            if (command === 'pm2 restart ahram-pay') started = true;
            return '';
        },
        execFileSync(_exe, args) {
            const command = args.at(-1);
            if (command.includes('Get-NetTCPConnection'))
                return JSON.stringify(started ? [5000] : cut ? [] : [30400]);
            if (command.includes('Get-CimInstance')) return JSON.stringify(cut ? null : owner);
            if (command.includes('Stop-Process')) {
                effects.push('kill-owner');
                cut = true;
                return '';
            }
            throw new Error('UNEXPECTED_COMMAND');
        },
    };
    const fakeProcess = {
        platform: 'win32',
        cwd: () => '/project',
        env: {},
        exitCode: 0,
        argv: ['node', 'script', '--transaction', target.customId, ...(mode === 'check' ? [] : ['--apply'])],
    };
    class FakeDate extends Date {
        static now() {
            return now;
        }
    }
    const context = {
        process: fakeProcess,
        console: {
            log() {},
            error(...args) {
                errors.push(args.join(' '));
            },
        },
        Date: FakeDate,
        AbortSignal,
        setTimeout: (callback, ms) => {
            now += ms;
            queueMicrotask(callback);
        },
        fetch: async (url) => {
            expect(url).toBe('http://127.0.0.1:3000/health/ready');
            return {
                ok: mode !== 'not-ready',
                json: async () => ({ status: 'ok', startupReady: true, pid: 5000 }),
            };
        },
        require(name) {
            if (name === 'node:fs')
                return {
                    readFileSync: (file) => (file.endsWith('pm2.pid') ? '33564' : 'startBoundHttpServer'),
                    mkdirSync() {},
                    copyFileSync() {},
                    writeFileSync() {},
                };
            if (name === 'node:path') return path.posix;
            if (name === 'node:os') return { homedir: () => '/home' };
            if (name === 'node:crypto') return { randomUUID: () => 'test-token' };
            if (name === 'node:child_process') return cp;
            if (name === '../services/apiRuntimeRecoveryPolicy') return policy;
            if (name === 'dotenv') return { config() {} };
            if (name === 'mongoose') return mongo;
            if (name === 'ioredis') return Redis;
            if (name === 'bullmq')
                return {
                    Queue: class {
                        constructor(_name, options) {
                            expect(options.skipMetasUpdate).toBe(true);
                            return queue;
                        }
                    },
                };
            throw new Error('UNEXPECTED_MODULE');
        },
    };
    await vm.runInNewContext(source, context);
    expect(paid).toEqual(paidBefore);
    return { effects, errors, paused, target, exitCode: fakeProcess.exitCode };
}

test('default check makes no operational or financial mutations', async () => {
    const result = await exercise('check');
    expect(result.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.effects).toEqual([]);
});
test('successful recovery fences first, removes only archived jobs and enqueues once before resuming', async () => {
    const result = await exercise('ok');
    expect(result.exitCode).toBe(0);
    expect(result.effects).toEqual([
        'pause',
        'fence',
        'pm2 stop ahram-pay',
        'kill-owner',
        'remove:1',
        'remove:2',
        'enqueue',
        'pm2 restart ahram-pay',
        'pm2 save',
        'release',
        'resume',
    ]);
    expect(result.target.apiResultData).toEqual({});
    expect(result.paused).toBe(false);
});
test.each(['paid-target', 'other-active', 'wrong-owner', 'other-claim'])(
    'unsafe preflight %s stops before any mutation',
    async (mode) => {
        const result = await exercise(mode);
        expect(result.exitCode).toBe(1);
        expect(result.effects).toEqual([]);
    }
);
test('a concurrent Payment claim aborts recovery before stopping any process', async () => {
    const result = await exercise('claim-race');
    expect(result.exitCode).toBe(1);
    expect(result.effects).toEqual(['pause', 'resume']);
    expect(result.target.apiResultData.providerDispatchAttemptId).toBe('real-payment-claim');
});
test.each(['release-conflict', 'not-ready', 'two-workers'])(
    'post-cutover failure %s keeps the target fenced and the queue paused',
    async (mode) => {
        const result = await exercise(mode);
        expect(result.exitCode).toBe(1);
        expect(result.paused).toBe(true);
        expect(result.effects).not.toContain('resume');
        expect(result.target.apiResultData.runtimeRecoveryFence).toBeTruthy();
        const reason = {
            'release-conflict': 'TARGET_CHANGED_FENCE_NOT_RELEASED',
            'not-ready': 'NEW_APPLICATION_NOT_READY',
            'two-workers': 'NEW_APPLICATION_NOT_STABLE',
        }[mode];
        expect(result.errors.join(' ')).toContain(reason);
    }
);
