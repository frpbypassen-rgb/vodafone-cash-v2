'use strict';
const http = require('node:http');
const express = require('express');
const { startupGate, startBoundHttpServer } = require('../services/httpStartupService');
const servers = [];
afterEach(async () => {
    await Promise.all(
        servers.map(
            (server) =>
                new Promise((resolve) => {
                    if (!server.listening) return resolve();
                    server.close(resolve);
                    server.closeAllConnections?.();
                })
        )
    );
    servers.length = 0;
});
const makeServer = (handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    return server;
};

test('port collision rejects before any worker starts and leaves the original service intact', async () => {
    const original = makeServer((_req, res) => res.end('original'));
    await new Promise((resolve) => original.listen(0, '127.0.0.1', resolve));
    const initialize = jest.fn();
    const ready = jest.fn();
    const duplicate = makeServer();
    const port = original.address().port;
    await expect(
        startBoundHttpServer({ server: duplicate, port, host: '127.0.0.1', initialize, onReady: ready })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(initialize).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('original');
});

test('financial HTTP requests stay gated until initialization succeeds while health remains readable', async () => {
    const app = express();
    let isReady = false,
        release;
    const initialization = new Promise((resolve) => {
        release = resolve;
    });
    const mutation = jest.fn((_req, res) => res.json({ success: true }));
    app.use(startupGate(() => isReady));
    app.get('/health', (_req, res) => res.json({ ready: isReady }));
    app.post('/transfer', mutation);
    const server = makeServer(app);
    const startup = startBoundHttpServer({
        server,
        port: 0,
        host: '127.0.0.1',
        initialize: () => initialization,
        onReady: () => {
            isReady = true;
        },
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const before = await fetch(base + '/transfer', { method: 'POST' });
    expect(before.status).toBe(503);
    expect(before.headers.get('retry-after')).toBe('5');
    expect(await before.json()).toEqual({ success: false, code: 'APPLICATION_STARTING' });
    expect(mutation).not.toHaveBeenCalled();
    expect(await (await fetch(base + '/health')).json()).toEqual({ ready: false });
    release();
    await startup;
    expect((await fetch(base + '/transfer', { method: 'POST' })).status).toBe(200);
    expect(mutation).toHaveBeenCalledTimes(1);
});

test('failed initialization releases the reserved port without marking the app ready', async () => {
    const server = makeServer();
    const ready = jest.fn();
    await expect(
        startBoundHttpServer({
            server,
            port: 0,
            host: '127.0.0.1',
            initialize: async () => {
                throw new Error('WORKER_INIT_FAILED');
            },
            onReady: ready,
        })
    ).rejects.toThrow('WORKER_INIT_FAILED');
    expect(server.listening).toBe(false);
    expect(ready).not.toHaveBeenCalled();
});
