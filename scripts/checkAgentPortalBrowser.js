'use strict';

// Standalone local fixtures: this script never authenticates against production.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_SECRET']) {
    process.env[key] = crypto.randomBytes(32).toString('hex');
}
const express = require('express');
const { renderAgentPage, buildAgentWorkspace } = require('../tests/helpers/agentPortalFixtures');
const { canAccessPage } = require('../services/businessPortalService');
const { loadPuppeteer } = require('../utils/puppeteerLoader');

async function main() {
    const output = process.argv[2] || path.join(os.tmpdir(), 'ahram-agent-portal-browser-review');
    fs.mkdirSync(output, { recursive: true });
    const roles = ['owner', 'manager', 'accountant', 'employee'];
    const pages = [
        'overview',
        'services',
        'service_workbench',
        'smart_transfer',
        'internal_transfer',
        'transactions',
        'reports',
        'settings',
        'security',
        'support',
        'customers',
        'customer_profile',
        'staff',
        'agency_profits',
        'agency_debts',
        'finance',
        'agency_balances',
        'agency_account',
        'agency_position',
    ];
    const renderingErrors = [];
    for (const role of roles)
        for (const name of pages) {
            if (!canAccessPage(buildAgentWorkspace(role), name)) continue;
            try {
                await renderAgentPage(name, role);
            } catch (error) {
                renderingErrors.push(`${role}/${name}: ${error.message.split('\n').at(-1)}`);
            }
        }
    assert.deepEqual(renderingErrors, [], 'Fixture rendering must pass before launching Chrome');
    const app = express();
    const mutationAttempts = new Map();
    app.use(express.static(path.join(__dirname, '../public')));
    app.get('/preview/:page/:role', async (req, res) => {
        try {
            res.send(await renderAgentPage(req.params.page, req.params.role));
        } catch (error) {
            res.status(500).send(error.message);
        }
    });
    app.post('/agent-portal/transfer', (req, res) => {
        const key = req.get('x-agent-fixture-case');
        const attempts = mutationAttempts.get(key) || [];
        attempts.push({ idempotencyKey: req.get('idempotency-key'), csrf: req.get('x-csrf-token') });
        mutationAttempts.set(key, attempts);
        if (attempts.length === 1) return res.type('html').send('<html>Unexpected login response</html>');
        return res.json({
            success: true,
            customId: 'AGENT-UI-TEST',
            newBalance: '1000.00',
            message: 'نجح الاختبار المحلي',
        });
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
            unreadCount: 0,
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
        for (const role of roles) {
            const workspace = buildAgentWorkspace(role);
            for (const name of pages) {
                if (!canAccessPage(workspace, name)) continue;
                for (const width of [320, 390, 1440]) {
                    const page = await browser.newPage();
                    const errors = [];
                    page.on('pageerror', (error) => errors.push(error.message));
                    page.on('console', (message) => {
                        if (message.type() === 'error' && message.text().includes('initialization failed'))
                            errors.push(message.text());
                    });
                    await page.evaluateOnNewDocument(() => {
                        window.Swal = { fire: async () => ({ isConfirmed: false }), close() {} };
                        localStorage.setItem('ahram_client_theme', 'day');
                    });
                    await page.setRequestInterception(true);
                    page.on('request', (request) => {
                        if (
                            request.resourceType() === 'script' &&
                            (!request.url().startsWith(baseUrl) || request.url().includes('/socket.io/'))
                        ) {
                            return request.respond({
                                status: 200,
                                contentType: 'application/javascript',
                                body: '',
                            });
                        }
                        return request.continue();
                    });
                    await page.setViewport({ width, height: 950, deviceScaleFactor: 1 });
                    const response = await page.goto(`${baseUrl}/preview/${name}/${role}`, {
                        waitUntil: 'networkidle2',
                        timeout: 45000,
                    });
                    assert.equal(response.status(), 200, `${role}/${name}: ${await page.content()}`);
                    assert.deepEqual(errors, [], `${role}/${name}/${width}: JavaScript error`);
                    await page
                        .waitForFunction(() => document.body.dataset.workspaceReady === 'true', {
                            timeout: 10000,
                        })
                        .catch((error) => {
                            throw new Error(
                                role + '/' + name + ': ' + errors.join('; ') + ' ' + error.message
                            );
                        });
                    const layout = await page.evaluate(() => ({
                        viewport: innerWidth,
                        width: document.documentElement.scrollWidth,
                        htmlRole: document.documentElement.dataset.agentRole,
                        bodyRole: document.body.dataset.agentRole,
                        companyShell: document.body.hasAttribute('data-company-shell'),
                        companyScripts: [...document.scripts].filter((script) =>
                            /\/js\/(company-|client-workspace)/.test(script.src)
                        ).length,
                        transferForms: document.querySelectorAll('#businessTransferForm').length,
                        wrongPortalLinks: [...document.querySelectorAll('a[href]')].filter((a) =>
                            /^\/(admin|executor-portal)(\/|$)/.test(a.getAttribute('href'))
                        ).length,
                    }));
                    assert.ok(
                        layout.width <= width + 1,
                        `${role}/${name}/${width}: horizontal overflow ${layout.width}`
                    );
                    assert.equal(
                        layout.htmlRole,
                        layout.bodyRole,
                        `${role}/${name}: inconsistent role markers`
                    );
                    assert.ok(layout.transferForms <= 1, `${role}/${name}: duplicate transfer form`);
                    assert.equal(layout.companyShell, false, 'Agent page must not be a company shell');
                    assert.equal(layout.companyScripts, 0, 'Agent page must not load company entrypoints');
                    assert.equal(layout.wrongPortalLinks, 0, `${role}/${name}: foreign portal link`);
                    if (role === 'owner' && ['services', 'reports', 'staff', 'settings'].includes(name)) {
                        await page.screenshot({
                            path: path.join(output, `${name}-${width}.png`),
                            fullPage: width >= 768,
                        });
                    }
                    results.push({ page: name, role, width, status: 'PASS', layout });
                    fs.writeFileSync(
                        path.join(output, 'browser-results.json'),
                        JSON.stringify(results, null, 2)
                    );
                    await page.close();
                }
            }
        }
        for (const width of [390, 1440]) {
            const page = await browser.newPage();
            const errors = [];
            const oldNamespaceRequests = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('request', (request) => {
                if (new URL(request.url()).pathname.startsWith('/client/'))
                    oldNamespaceRequests.push(request.url());
            });
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                if (
                    request.resourceType() === 'script' &&
                    (!request.url().startsWith(baseUrl) || request.url().includes('/socket.io/'))
                ) {
                    return request.respond({ status: 200, contentType: 'application/javascript', body: '' });
                }
                return request.continue();
            });
            await page.setExtraHTTPHeaders({ 'x-agent-fixture-case': String(width) });
            await page.setViewport({ width, height: 950 });
            await page.goto(`${baseUrl}/preview/service_workbench/owner`, { waitUntil: 'networkidle2' });
            await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
            await page.evaluate(() => {
                document.getElementById('transferDestination').value = '01012345678';
                document.getElementById('transferAmount').value = '1000';
                document
                    .getElementById('transferAmount')
                    .dispatchEvent(new Event('input', { bubbles: true }));
            });
            const send = async () => {
                await page.evaluate(() =>
                    document
                        .getElementById('businessTransferForm')
                        .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
                );
                await page.waitForFunction(() => document.getElementById('transferConfirmDialog').open);
                await page.evaluate(() => {
                    const button = document.getElementById('transferConfirmSubmit');
                    button.click();
                    button.click();
                });
            };
            await send();
            await page.waitForFunction(() =>
                document.getElementById('transferFormResult').classList.contains('danger')
            );
            assert.equal(
                await page.$eval('#transferAmount', (input) => input.value),
                '1000',
                'An uncertain result must preserve the form'
            );
            assert.equal(
                await page.$eval('#transferSuccessDialog', (dialog) => dialog.open),
                false,
                'HTML must not confirm a transfer'
            );
            await send();
            await page.waitForFunction(() => document.getElementById('transferSuccessDialog').open);
            const attempts = mutationAttempts.get(String(width));
            assert.equal(attempts.length, 2, 'Double-clicking confirmation must not duplicate submissions');
            assert.ok(attempts[0].idempotencyKey);
            assert.equal(
                attempts[0].idempotencyKey,
                attempts[1].idempotencyKey,
                'Retry after an uncertain response must reuse the idempotency key'
            );
            assert.equal(attempts[0].csrf, 'test-csrf');
            assert.deepEqual(errors, []);
            assert.deepEqual(
                oldNamespaceRequests,
                [],
                'Agency requests must stay out of the legacy client namespace'
            );
            results.push({
                page: 'transfer-retry',
                role: 'owner',
                width,
                status: 'PASS',
                attempts: attempts.length,
            });
            fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
            await page.close();
        }
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
