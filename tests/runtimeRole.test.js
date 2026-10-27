'use strict';
const express = require('express');
const request = require('supertest');
const {
    readRuntimeRole,
    allowsBackgroundWork,
    runtimeBindHost,
    runtimeRoleGate,
} = require('../utils/runtimeRole');
test('existing runtime stays full; probe role cannot start background work', () => {
    expect(readRuntimeRole({})).toBe('full');
    expect(allowsBackgroundWork({})).toBe(true);
    for (const role of ['probe']) {
        expect(allowsBackgroundWork({ RUNTIME_ROLE: role })).toBe(false);
        expect(runtimeBindHost({ RUNTIME_ROLE: role })).toBe('127.0.0.1');
    }
    expect(runtimeBindHost({})).toBeUndefined();
    expect(() => readRuntimeRole({ RUNTIME_ROLE: 'typo' })).toThrow();
    expect(() => readRuntimeRole({ RUNTIME_ROLE: 'web' })).toThrow();
    expect(() =>
        runtimeBindHost({ RUNTIME_ROLE: 'probe', HTTP_BIND_HOST: '0.0.0.0' }),
    ).toThrow();
});
test('probe admits only health reads: neither financial POSTs, GET handlers nor login can run', async () => {
    const reached = jest.fn();
    const app = express();
    app.use(runtimeRoleGate({ RUNTIME_ROLE: 'probe' }));
    app.get('/health/ready', (_req, res) => res.json({ status: 'ok' }));
    app.use((req, res) => {
        reached();
        res.json({ path: req.path });
    });
    await request(app).get('/health/ready').expect(200);
    for (const path of [
        '/api/v1/merchant/transfer',
        '/login',
        '/executor/test',
        '/socket.io/',
    ]) {
        await request(app).post(path).expect(503);
        await request(app).get(path).expect(503);
    }
    expect(reached).not.toHaveBeenCalled();
});
test('the normal full role preserves request authorization/mutation handlers', async () => {
    for (const role of ['full']) {
        const app = express();
        app.use(runtimeRoleGate({ RUNTIME_ROLE: role }));
        app.post('/transfer', (_req, res) =>
            res.status(201).json({ test: true }),
        );
        await request(app).post('/transfer').expect(201, { test: true });
    }
});
test('a probe cannot enable consumers through inherited production flags', () => {
    const controls = require('../utils/runtimeControls');
    const env = {
        NODE_ENV: 'production',
        RUNTIME_ROLE: 'probe',
        BULLMQ_WORKERS_ENABLED: 'true',
        FINANCIAL_SCHEDULERS_ENABLED: 'true',
        MERCHANT_WEBHOOK_WORKER_ENABLED: 'true',
    };
    expect(controls.isBullmqWorkersEnabled(env)).toBe(false);
    expect(controls.isFinancialSchedulersEnabled(env)).toBe(false);
    expect(controls.isMerchantWebhookWorkerEnabled(env)).toBe(false);
});
test('the probe config is loopback-only and cannot restart or replace the live PM2 application', () => {
    const { apps } = require('../ecosystem.runtime-probe.config');
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
        name: 'ahram-pay-probe',
        autorestart: false,
        watch: false,
        instances: 1,
    });
    expect(apps[0].env).toMatchObject({
        PORT: '3001',
        HTTP_BIND_HOST: '127.0.0.1',
        RUNTIME_ROLE: 'probe',
        BULLMQ_WORKERS_ENABLED: 'false',
        FINANCIAL_SCHEDULERS_ENABLED: 'false',
        MERCHANT_WEBHOOK_WORKER_ENABLED: 'false',
        EXTERNAL_API_ENABLED: 'false',
    });
    expect(runtimeBindHost(apps[0].env)).toBe('127.0.0.1');
});
