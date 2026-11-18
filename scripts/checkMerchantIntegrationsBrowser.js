'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const { assertLocalSeedTarget, requireSecret } = require('./lib/productionDatabaseGuard');
const Company = require('../models/ClientCompany');
const User = require('../models/User');
const service = require('../services/merchantIntegrationService');
const base = 'http://127.0.0.1:4577';
async function main() {
    const target = assertLocalSeedTarget(process.env);
    if (target.databaseName !== 'ahram_company_mobile_demo_v2')
        throw new Error('Only the isolated company preview database is supported.');
    const password = requireSecret(process.env, 'COMPANY_DEMO_PASSWORD', 12);
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    const browser = await (
        await loadPuppeteer()
    ).launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
    const output = path.resolve('outputs/merchant-integrations-browser');
    fs.mkdirSync(output, { recursive: true });
    const restore = [];
    try {
        const company = await Company.findOne({ accountCode: 'CO-MOBILE-DEMO' }).lean();
        assert(company);
        let agent = await User.findOne({ webUsername: 'integration_browser_demo@ahram.com' });
        if (!agent)
            agent = await User.create({
                name: 'وكالة اختبار التكاملات',
                webUsername: 'integration_browser_demo@ahram.com',
                webPassword: password,
                role: 'agent',
                status: 'active',
            });
        for (const [kind, Model, id, username, portal] of [
            ['company', Company, company._id, 'company_demo@ahram.com', '/client'],
            ['agent', User, agent._id, 'integration_browser_demo@ahram.com', '/agent-portal'],
        ]) {
            const original = await Model.findById(id).select('+merchantApiKeyHash +apiToken').lean();
            restore.push([Model, id, original]);
            await service.setAdminAccess(Model, { _id: id }, { apiEnabled: false, webhooksEnabled: false });
            const context = await browser.createBrowserContext();
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('dialog', (dialog) => dialog.accept());
            await page.setViewport({ width: 390, height: 844, isMobile: true });
            await page.setRequestInterception(true);
            page.on('request', (request) =>
                request.url().startsWith(base) || request.url().startsWith('data:')
                    ? request.continue()
                    : request.abort()
            );
            await page.goto(base + '/login?portal=client', { waitUntil: 'domcontentloaded' });
            await page.type('#usernameInput', username);
            await page.type('#passwordInput', password);
            assert.equal(await page.$eval('#usernameInput', input => input.value), username, 'Login username must be entered before submission');
            assert.equal(await page.$eval('#passwordInput', input => input.value), password, 'Login password must be entered before submission');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
                page.$eval('#loginForm', (form) => form.requestSubmit()),
            ]);
            assert.notEqual(new URL(page.url()).pathname, '/login', 'Login must leave the credential form');
            await page.goto(base + portal + '/settings#integrations', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
            if (await page.$eval('#companyWelcomeDialog', (dialog) => dialog.open).catch(() => false))
                await page.locator('#companyWelcomeDialog [data-dialog-close]').click();
            await page.waitForFunction(() =>
                document.querySelector('[data-mi-api-state]')?.textContent.includes('موقوف من الإدارة')
            );
            assert.equal(await page.$eval('[data-mi-api-link]', link => link.getAttribute('aria-disabled')), 'true');
            await service.setAdminAccess(Model, { _id: id }, { apiEnabled: true, webhooksEnabled: true });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
            await page.waitForFunction(() => document.querySelector('[data-mi-api-link]')?.getAttribute('aria-disabled') === 'false');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
                page.locator('[data-mi-api-link]').click(),
            ]);
            assert.equal(new URL(page.url()).pathname, portal + '/integrations/api');
            await page.waitForFunction(() => document.querySelector('[data-api-rotate]')?.disabled === false);
            const passwordInput = '[data-api-dialog] [name="currentPassword"]';
            const rotate = async () => {
                await page.locator('[data-api-rotate]').click();
                await page.waitForSelector(passwordInput, { visible: true });
                await page.type(passwordInput, password);
                await page.locator('[data-api-dialog] button[form="api-confirm-form"]').click();
                await page.waitForFunction(
                    () =>
                        document.querySelector('[data-api-dialog]')?.open &&
                        document.querySelector('[data-api-dialog] textarea.api-secret')?.value.startsWith('ahr_')
                );
                return page.$eval('[data-api-dialog] textarea.api-secret', input => input.value);
            };
            const closeIssuedKey = async () => {
                await page.waitForFunction(() => !document.querySelector('[data-api-rotate]').disabled);
                await page.$eval('[data-api-dialog] [data-close]', button => button.click());
                await page.waitForFunction(() => {
                    const dialog = document.querySelector('[data-api-dialog]');
                    return !dialog.open && !dialog.querySelector('textarea.api-secret');
                });
                assert.equal(await page.$('[data-api-dialog] textarea.api-secret'), null, 'Closing the one-time key dialog must remove its secret');
            };
            const key1 = await rotate();
            const check = async (key) =>
                (await fetch(base + '/api/v1/merchant/balance', { headers: { 'x-api-key': key } })).status;
            assert.equal(await check(key1), 200);
            await closeIssuedKey();
            const key2 = await rotate();
            assert.notEqual(key1, key2);
            assert.equal(await check(key1), 401);
            assert.equal(await check(key2), 200);
            await closeIssuedKey();
            await page.waitForFunction(() => !document.querySelector('[data-api-revoke]').disabled);
            await page.locator('[data-api-revoke]').click();
            await page.waitForSelector(passwordInput, { visible: true });
            await page.type(passwordInput, password);
            await page.locator('[data-api-dialog] button[form="api-confirm-form"]').click();
            await page.waitForFunction(() =>
                document.querySelector('[data-api-notice]').textContent.includes('تم إيقاف')
            );
            assert.equal(await check(key2), 401);
            assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
                false
            );
            await page.screenshot({ path: path.join(output, kind + '-integrations.png'), fullPage: true });
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
                page.locator('[data-api-webhooks]').click(),
            ]);
            assert(page.url().endsWith(portal + '/integrations/webhooks'));
            await page.waitForFunction(() => document.querySelector('[data-wh-create]')?.disabled === false);
            await page.locator('[data-wh-create]').click();
            await page.waitForSelector('merchant-webhooks dialog[open] [data-editor]');
            assert.ok(await page.$('merchant-webhooks dialog[open] input[name="url"][required]'));
            assert.ok(await page.$('merchant-webhooks dialog[open] input[name="name"][required]'));
            await page.locator('merchant-webhooks dialog[open] [data-action="close"]').click();
            await page.waitForFunction(() => !document.querySelector('merchant-webhooks dialog').open);
            for (const width of [320, 390, 430]) {
                await page.setViewport({ width, height: 844, isMobile: true });
                assert.equal(
                    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
                    false
                );
            }
            assert.deepEqual(errors, []);
            await context.close();
        }
        console.log(
            JSON.stringify({
                passed: true,
                portals: ['company', 'agent'],
                mobile: true,
                activation: true,
                rotationInvalidatesPreviousKey: true,
                revocation: true,
                webhookPage: true,
            })
        );
    } finally {
        for (const [Model, id, original] of restore) {
            const set = {},
                unset = {};
            for (const key of ['integrationAccess', 'merchantApiKeyHash', 'token', 'apiToken']) {
                if (original[key] === undefined) unset[key] = 1;
                else set[key] = original[key];
            }
            await Model.updateOne({ _id: id }, { $set: set, $unset: unset });
        }
        await browser.close();
        await mongoose.disconnect();
    }
}
main().catch((error) => {
    console.error(error.message);
    console.error(error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).join('\n'));
    process.exitCode = 1;
});
