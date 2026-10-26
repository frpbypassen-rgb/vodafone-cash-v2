'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const base = 'http://127.0.0.1:4577';
async function main() {
    if (!process.env.COMPANY_DEMO_PASSWORD) throw new Error('COMPANY_DEMO_PASSWORD is required');
    const jar = new Map();
    const remember = (r) =>
        r.headers.getSetCookie().forEach((v) => {
            const pair = v.split(';')[0];
            jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
        });
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const initial = await fetch(base + '/login?portal=client');
    remember(initial);
    const csrf = (await initial.text()).match(/name="_csrf" value="([^"]+)"/)[1];
    const login = await fetch(base + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            _csrf: csrf,
            username: 'company_demo@ahram.com',
            password: process.env.COMPANY_DEMO_PASSWORD,
            portal: 'client',
        }),
    });
    remember(login);
    if (login.status !== 302) throw new Error('Demo login failed');
    const browser = await (
        await loadPuppeteer()
    ).launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
    const results = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844, isMobile: true });
        if (process.argv.includes('--mobile')) {
            const cdp = await page.createCDPSession();
            await cdp.send('Network.enable');
            await cdp.send('Network.emulateNetworkConditions', {
                offline: false,
                latency: 100,
                downloadThroughput: 200000,
                uploadThroughput: 100000,
            });
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        }
        await page.setCookie(...[...jar].map(([name, value]) => ({ name, value, url: base })));
        const mode = process.argv.includes('--block-external') ? 'blocked' : 'normal';
        if (mode === 'blocked') {
            await page.setRequestInterception(true);
            page.on('request', (r) =>
                r.url().startsWith(base) || r.url().startsWith('data:') ? r.continue() : r.abort()
            );
        }
        const pending = new Map();
        const failed = [];
        page.on('request', (r) => pending.set(r, r.url()));
        page.on('requestfinished', (r) => pending.delete(r));
        page.on('requestfailed', (r) => {
            pending.delete(r);
            failed.push({ url: r.url(), error: r.failure()?.errorText });
        });
        for (const route of [
            '/client/dashboard?home=1',
            '/client/services',
            '/client/settings',
            '/client/staff',
        ]) {
            pending.clear();
            failed.length = 0;
            const start = Date.now();
            let timedOut = false;
            try {
                await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 10000 });
                await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true', {
                    timeout: 5000,
                });
            } catch (_e) {
                timedOut = true;
            }
            const elapsed = Date.now() - start;
            const timing = await page.evaluate(() => {
                const n = performance.getEntriesByType('navigation')[0];
                const resources = performance.getEntriesByType('resource');
                return {
                    ttfb: Math.round(n.responseStart - n.requestStart),
                    dom: Math.round(n.domContentLoadedEventEnd),
                    resources: resources.length,
                    css: document.querySelectorAll('link[rel="stylesheet"]').length,
                    ready: document.body.dataset.workspaceReady === 'true',
                    transferModules: resources
                        .filter((r) => /\/(services|transfers|smart-transfer)\.js/.test(r.name))
                        .map((r) => new URL(r.name).pathname),
                    chartRequested: resources.some((r) => r.name.includes('/chart.js@')),
                };
            });
            if (!route.includes('/dashboard'))
                assert.deepEqual(
                    timing.transferModules,
                    [],
                    'Simple pages must not load transfer controllers'
                );
            assert.equal(timing.chartRequested, false, 'Phone navigation must not download desktop charts');
            assert.equal(timedOut, false, `Navigation timed out: ${route}`);
            assert.equal(timing.ready, true, `Page did not initialize: ${route}`);
            results.push({
                route,
                mode,
                elapsed,
                timedOut,
                ...timing,
                pending: [...pending.values()].filter((url) => !url.includes('socket.io/?')).slice(0, 8),
                failed: [...failed].filter((r) => !r.url.includes('socket.io/?')).slice(0, 8),
            });
        }
    } finally {
        await browser.close();
    }
    const output = process.argv.find((arg) => arg.endsWith('.json'));
    if (output) fs.writeFileSync(output, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
}
main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
