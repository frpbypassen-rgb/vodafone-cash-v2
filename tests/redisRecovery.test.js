'use strict';
const { EventEmitter } = require('node:events');
const oldEnv = { ...process.env };
let instances, failConnection;

beforeEach(() => {
    jest.resetModules();
    instances = [];
    failConnection = false;
    process.env.NODE_ENV = 'production';
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_URL = 'redis://127.0.0.1:16399';
    jest.doMock('ioredis', () => class extends EventEmitter {
        constructor(_url, options) { super(); this.options = options; this.status = 'wait'; instances.push(this); }
        async connect() { if (failConnection) throw new Error('offline'); this.status = 'ready'; this.emit('ready'); }
        async ping() { return 'PONG'; }
        disconnect() { this.status = 'end'; this.emit('end'); }
    });
});
afterEach(() => { process.env = { ...oldEnv }; jest.dontMock('ioredis'); });

test('a lost Redis connection is degraded immediately and becomes ready after reconnecting', async () => {
    const redis = require('../config/redis');
    const client = await redis.initRedis();
    expect(redis.isRedis()).toBe(true);
    client.status = 'reconnecting'; client.emit('close');
    expect(redis.isRedis()).toBe(false);
    expect(redis.createBullMQConnection()).toBeNull();
    client.status = 'ready'; client.emit('ready');
    expect(redis.isRedis()).toBe(true);
});

test('runtime reconnection keeps retrying after the old three-attempt cutoff', async () => {
    const client = await require('../config/redis').initRedis();
    expect(client.options.retryStrategy(4)).toBeGreaterThan(0);
    expect(client.options.retryStrategy(100)).toBeLessThanOrEqual(5000);
});

test('initial Redis connection failures still have a bounded retry budget', async () => {
    failConnection = true;
    await expect(require('../config/redis').initRedis()).rejects.toThrow('offline');
    expect(instances[0].options.retryStrategy(4)).toBeNull();
});

test('readiness performs a live PING instead of trusting an old connected flag', async () => {
    const redis = require('../config/redis');
    const client = await redis.initRedis();
    client.ping = async () => { throw new Error('Connection is closed.'); };
    expect(await redis.checkRedisReadiness()).toBe(false);
    client.ping = async () => 'PONG';
    expect(await redis.checkRedisReadiness()).toBe(true);
});

test('readiness is bounded when a Redis command stops responding', async () => {
    const redis = require('../config/redis');
    const client = await redis.initRedis();
    client.ping = () => new Promise(() => {});
    jest.useFakeTimers();
    try {
        const pending = redis.checkRedisReadiness();
        await jest.advanceTimersByTimeAsync(1001);
        expect(await pending).toBe(false);
    } finally { jest.useRealTimers(); }
});
