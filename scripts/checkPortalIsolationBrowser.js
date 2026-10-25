'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_SECRET'])
    process.env[name] = crypto.randomBytes(32).toString('hex');
const express = require('express');
const { renderAgentPage, renderWorkspacePage } = require('../tests/helpers/agentPortalFixtures');
const { loadPuppeteer } = require('../utils/puppeteerLoader');

async function main() {
    const output = process.argv[2] || path.join(os.tmpdir(), 'ahram-portal-isolation-browser');
    fs.mkdirSync(output, { recursive: true });
    const mutations = [];
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../public')));
    app.get('/socket.io/socket.io.js', (_req, res) => res.type('js').send(''));
    app.get('/fixture/:portal', async (req, res) => {
        try {
            res.send(
                await (req.params.portal === 'agent'
                    ? renderAgentPage('settings', 'owner', { clientTheme: 'day' })
                    : renderWorkspacePage('settings'))
            );
        } catch (error) {
            res.status(500).send(error.message);
        }
    });
    app.post(['/client/api/theme', '/agent-portal/api/theme'], (req, res) => {
        mutations.push({ path: req.path, theme: req.body.theme, csrf: req.get('x-csrf-token') });
        res.json({ success: true });
    });
    app.use((_req, res) =>
        res.json({
            success: true,
            enabled: false,
            supported: false,
            subscribed: false,
            notifications: [],
            notes: [],
            messages: [],
            tickets: [],
            transactions: [],
            serviceRates: { vodafone: 4.85 },
        })
    );
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let browser;
    const results = [];
    try {
        const puppeteer = await loadPuppeteer();
        browser = await puppeteer.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            headless: true,
        });
        for (const width of [390, 1440]) {
            const context = await browser.createBrowserContext();
            const company = await context.newPage();
            const agent = await context.newPage();
            const errors = [];
            for (const page of [company, agent]) {
                page.on('pageerror', (error) => errors.push(error.message));
                page.on('console', (message) => {
                    if (
                        message.type() === 'error' &&
                        /initialization failed|\[Company header\]|\[Company presentation\]/.test(
                            message.text()
                        )
                    )
                        errors.push(message.text());
                });
                await page.setViewport({ width, height: 950 });
            }
            assert.equal(
                (await company.goto(baseUrl + '/fixture/company', { waitUntil: 'networkidle2' })).status(),
                200
            );
            assert.equal(
                (await agent.goto(baseUrl + '/fixture/agent', { waitUntil: 'networkidle2' })).status(),
                200
            );
            for (const page of [company, agent])
                await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
            const before = mutations.length;
            await agent.evaluate(() => document.querySelector('[data-theme-option="night"]').click());
            await agent.waitForFunction(() => document.documentElement.dataset.theme === 'night');
            assert.equal(await company.evaluate(() => document.documentElement.dataset.theme), 'day');
            assert.equal(await agent.evaluate(() => localStorage.getItem('ahram_company_theme')), 'day');
            assert.equal(await agent.evaluate(() => localStorage.getItem('ahram_agent_theme')), 'night');
            await company.evaluate(() => document.querySelector('[data-theme-option="pharaonic"]').click());
            await company.waitForFunction(() => document.documentElement.dataset.theme === 'pharaonic');
            assert.equal(await agent.evaluate(() => document.documentElement.dataset.theme), 'night');
            assert.equal(await company.evaluate(() => localStorage.getItem('ahram_agent_theme')), 'night');
            const updates = mutations.slice(before);
            assert.deepEqual(updates.map((item) => item.path).sort(), [
                '/agent-portal/api/theme',
                '/client/api/theme',
            ]);
            assert.ok(updates.every((item) => item.csrf === 'test-csrf'));
            assert.deepEqual(errors, []);
            for (const [portal, page] of [
                ['agent', agent],
                ['company', company],
            ]) {
                const layout = await page.evaluate(() => ({
                    portal: document.documentElement.dataset.portal,
                    width: document.documentElement.scrollWidth,
                    viewport: innerWidth,
                }));
                assert.equal(layout.portal, portal);
                assert.ok(layout.width <= layout.viewport + 1);
                await page.screenshot({
                    path: path.join(output, `${portal}-${width}.png`),
                    fullPage: width >= 768,
                });
                results.push({ portal, width, status: 'PASS', themesIsolated: true });
            }
            await context.close();
        }
        fs.writeFileSync(path.join(output, 'isolation-results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ result: 'PASS', scenarios: results.length, output }));
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
