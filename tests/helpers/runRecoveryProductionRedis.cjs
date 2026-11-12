'use strict';
// Explicit integration run: real private Redis + the test's temporary Mongo replica set.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Redis = require('ioredis');
const root = path.resolve(__dirname, '../..');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1]; };

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ahram-production-redis-'));
    let server, client;
    try {
        const port = await new Promise((resolve, reject) => {
            const probe = net.createServer(); probe.on('error', reject);
            probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
        });
        const config = path.join(temp, 'redis.conf');
        fs.writeFileSync(config, `bind 127.0.0.1\nport ${port}\nsave ""\nappendonly no\nmaxmemory 128mb\nmaxmemory-policy noeviction\ndir "${temp.replace(/\\/g, '/')}"\n`);
        server = spawn(option('--redis-binary') || (process.platform === 'win32' ? 'C:/Program Files/Redis/redis-server.exe' : 'redis-server'),
            [config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
            let log = '';
            const timer = setTimeout(() => reject(new Error('PRIVATE_REDIS_START_TIMEOUT')), 10000);
            server.once('error', error => { clearTimeout(timer); reject(error); });
            server.once('exit', () => { clearTimeout(timer); reject(new Error('PRIVATE_REDIS_EXITED')); });
            server.stdout.on('data', chunk => {
                log += chunk;
                if (/ready to accept connections/i.test(log)) { clearTimeout(timer); resolve(); }
            });
            server.stderr.on('data', () => {});
        });
        client = new Redis(`redis://127.0.0.1:${port}`, { retryStrategy: () => null });
        if (!(await client.info('server')).includes(`process_id:${server.pid}`)) throw new Error('PRIVATE_REDIS_OWNER_MISMATCH');
        const output = path.resolve(option('--output') || path.join(temp, 'result.log'));
        const fd = fs.openSync(output, 'w');
        let code;
        try {
            const child = spawn(process.execPath, ['--experimental-vm-modules', path.join(root, 'node_modules/jest/bin/jest.js'),
                'tests/providerResolution.test.js', '--runInBand', '--testTimeout=180000', '--testNamePattern=CLI preview'], {
                cwd: root, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env,
                    NODE_ENV: 'test', RECOVERY_TEST_PRODUCTION: 'true', RECOVERY_TEST_REDIS_URL: `redis://127.0.0.1:${port}`,
                    JWT_SECRET: 'provider-audit-isolated-access-secret', JWT_REFRESH_SECRET: 'provider-audit-isolated-refresh-secret',
                    SESSION_SECRET: 'provider-audit-isolated-session-secret', MONGO_URI: 'mongodb://127.0.0.1:1/unused',
                    DOTENV_CONFIG_PATH: path.join(temp, 'absent-env'), NODE_OPTIONS: '--use-system-ca --max-old-space-size=1536'
                }
            });
            code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        } finally { fs.closeSync(fd); }
        if (code === 0 && !/cmdstat_eval(?:sha)?:calls=[1-9]\d*/.test(await client.info('commandstats'))) {
            throw new Error('NO_REAL_REDIS_LOCK_CALLS');
        }
        if ((await client.keys('bull:*')).length) throw new Error('UNEXPECTED_TEST_WORKER_KEYS');
        console.log(JSON.stringify({ productionRedisRecovery: code === 0 ? 'PASS' : 'FAIL', output }));
        process.exitCode = code === 0 ? 0 : 1;
    } finally {
        if (client) client.disconnect();
        if (server && server.exitCode === null) {
            await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
        }
        if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('ahram-production-redis-')) throw new Error('UNSAFE_TEST_CLEANUP');
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch(() => { console.error('ISOLATED_PRODUCTION_REDIS_TEST_FAILED'); process.exitCode = 1; });
