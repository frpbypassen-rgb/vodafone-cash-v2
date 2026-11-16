'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Redis = require('ioredis');
const binary = process.env.REDIS_TEST_BINARY || 'C:/Program Files/Redis/redis-server.exe';
let server, client, directory, guard, service, queryCount = 0;
const input = { ownerModel: 'User', ownerId: 'isolated-lock-fixture', serviceKey: 'vodafone', recipient: '01000000000', amount: 100 };
const oldEnv = Object.fromEntries(['NODE_ENV', 'REDIS_URL', 'REDIS_ENABLED'].map(key => [key, process.env[key]]));

before(async () => {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ahram-lock-regression-'));
    fs.writeFileSync(path.join(directory, 'redis.conf'), `bind 127.0.0.1\nport ${port}\nsave ""\nappendonly no\n`);
    server = spawn(binary, [path.join(directory, 'redis.conf')], { cwd: directory, windowsHide: true, stdio: 'ignore' });
    let launchError;
    server.on('error', error => { launchError = error; });
    client = new Redis(`redis://127.0.0.1:${port}`, { lazyConnect: true, retryStrategy: null, connectTimeout: 1000 });
    client.on('error', () => {});
    for (let attempt = 0; attempt < 30; attempt++) {
        if (launchError) throw launchError;
        try { await client.connect(); break; } catch (_) { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(await client.ping(), 'PONG');
    process.env.NODE_ENV = 'production';
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
    const config = require('../config/redis');
    await config.initRedis();
    guard = config.getRedisClient();
    // No financial database or provider is used; exercise the real lock and Lua path.
    require('../models/Transaction').findOne = () => { queryCount++; return { sort: () => ({ lean: async () => null }) }; };
    service = require('../services/transferCooldownService');
});

after(async () => {
    guard?.disconnect();
    client?.disconnect();
    if (server && server.exitCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        server.kill();
        await exited;
    }
    if (directory) {
        fs.unlinkSync(path.join(directory, 'redis.conf'));
        fs.rmdirSync(directory);
    }
    for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});

test('real Redis serializes duplicate requests, reports actual remaining TTL and allows reuse after release', async () => {
    const first = await service.acquireTransferCooldown(input);
    const beforeQueries = queryCount;
    await assert.rejects(service.acquireTransferCooldown(input), error => {
        assert.equal(error.code, 'TRANSFER_COOLDOWN_LOCK_TIMEOUT');
        assert.equal(error.statusCode, 429);
        assert.ok(error.retryAfterSeconds > 30 && error.retryAfterSeconds <= 45);
        return true;
    });
    assert.equal(queryCount, beforeQueries);
    await service.releaseTransferCooldown(first.lock);
    const second = await service.acquireTransferCooldown(input);
    await service.releaseTransferCooldown(second.lock);
});

test('healthy Redis ping with writes blocked is unavailable, never a fake duplicate; recovery works without restarting the app', async () => {
    const beforeQueries = queryCount;
    await client.config('SET', 'maxmemory', '1');
    try {
        assert.equal(await client.ping(), 'PONG');
        await assert.rejects(service.acquireTransferCooldown(input), { code: 'TRANSFER_GUARD_UNAVAILABLE', statusCode: 503 });
        assert.equal(queryCount, beforeQueries);
    } finally { await client.config('SET', 'maxmemory', '0'); }
    const recovered = await service.acquireTransferCooldown(input);
    await service.releaseTransferCooldown(recovered.lock);
});

test('a Redis outage degrades readiness and the same application client reconnects after the server returns', async () => {
    const redis = require('../config/redis');
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
    for (let attempt = 0; attempt < 30 && guard.status === 'ready'; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(redis.isRedis(), false);
    assert.equal(await redis.checkRedisReadiness(), false);
    server = spawn(binary, [path.join(directory, 'redis.conf')], { cwd: directory, windowsHide: true, stdio: 'ignore' });
    for (let attempt = 0; attempt < 120 && !redis.isRedis(); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(redis.isRedis(), true);
    assert.equal(await redis.checkRedisReadiness(), true);
    const recovered = await service.acquireTransferCooldown(input);
    await service.releaseTransferCooldown(recovered.lock);
});
