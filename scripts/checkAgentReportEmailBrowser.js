'use strict';
// Isolated database and intercepted SMTP only: never connects to a production account.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.NODE_ENV = 'test';
process.env.TENANT_MODE = 'multi';
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.TELEGRAM_BOT_TOKEN = 'test-token-not-real';
process.env.TELEGRAM_BOT_USERNAME = 'Ahrampay_bot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const mailer = require('../services/agentReportEmailMailer');
let sentCode = '', sentPdf = null;
mailer.configured = () => true;
mailer.sendCode = async (_email, code) => { sentCode = code; };
mailer.sendStatement = async (message) => { sentPdf = message; };
const Subscription = require('../models/AgentReportEmail');
const Delivery = require('../models/AgentReportEmailDelivery');
const User = require('../models/User');
const TelegramLink = require('../models/TelegramAccountLink');
const TelegramDelivery = require('../models/TelegramDelivery');
const TelegramClaim = require('../models/TelegramReceiptClaim');
const TelegramConnection = require('../models/AgentTelegramConnection');
const telegram = require('../services/telegramService');
const router = require('../routes/agentReportEmail');
const csrf = require('../middlewares/csrfProtection');
const { renderAgentPage } = require('../tests/helpers/agentPortalFixtures');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const { closeReportPdfBrowser } = require('../services/reportPdfService');

async function main() {
    const output = path.resolve(process.argv[2] || 'outputs/agent-email-browser');
    fs.mkdirSync(output, { recursive: true });
    const mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    const originalFetch = global.fetch;
    let receiptPhotos = 0;
    global.fetch = async (url, options) => {
        if (String(url).startsWith('https://api.telegram.org/')) {
            if (String(url).endsWith('/sendPhoto')) receiptPhotos++;
            return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
        }
        return originalFetch(url, options);
    };
    let server, browser;
    try {
        await mongoose.connect(mongo.getUri());
        await Promise.all([Subscription.init(), Delivery.init(), TelegramLink.init(), TelegramDelivery.init(), TelegramClaim.init(), TelegramConnection.init()]);
        const actor = { _id: new mongoose.Types.ObjectId(), role: 'agent', status: 'active', name: 'وكالة اختبار البريد', phone: '0911111111', sessionVersion: 0, tenantId: new mongoose.Types.ObjectId() };
        await User.collection.insertOne(actor);
        const session = { isClientLoggedIn: true, clientId: actor._id, accountType: 'user', clientSessionVersion: 0, csrfToken: 'test-csrf' };
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => { req.session = session; req.tenant = { _id: actor.tenantId }; next(); });
        app.use('/webhooks/telegram', require('../routes/telegramWebhook'));
        app.use(csrf);
        app.use(express.static(path.join(__dirname, '../public')));
        app.use('/agent-portal', router);
        app.use('/agent-portal', require('../routes/agentTelegram'));
        app.get('/agent-portal/settings', async (_req, res) => res.send(await renderAgentPage('settings')));
        app.use((_req, res) => res.json({ success: true, notifications: [], messages: [], notes: [], tickets: [], sessions: [], transactions: [], unreadCount: 0, enabled: false }));
        server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        const invalidCsrf = await fetch(`${base}/agent-portal/api/report-email/request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'wrong@example.com' }) });
        assert.equal(invalidCsrf.status, 403);
        const puppeteer = await loadPuppeteer();
        browser = await puppeteer.launch({ headless: true, ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}) });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
        await page.evaluateOnNewDocument(() => { window.Swal = { fire: async () => ({ isConfirmed: false }), close() {} }; });
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.resourceType() === 'script' && (!request.url().startsWith(base) || request.url().includes('/socket.io/'))) return request.respond({ status: 200, contentType: 'application/javascript', body: '' });
            return request.continue();
        });
        const ready = () => page.waitForFunction(() => document.body.dataset.workspaceReady === 'true' && !document.querySelector('[data-report-email-toggle]').disabled);
        const click = async (selector) => {
            await page.$eval(selector, element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
            await page.click(selector);
        };
        await page.goto(`${base}/agent-portal/settings#notifications`, { waitUntil: 'networkidle2' });
        await ready();
        assert.equal(await page.$('[data-notification-preference="sms"]'), null);
        await click('[data-report-email-toggle]');
        await page.type('[data-report-email-request] input', 'daily@example.com');
        await click('[data-report-email-send]');
        await page.waitForFunction(() => !document.querySelector('[data-report-email-verify]').hidden && !document.querySelector('[data-report-email-verify] input').disabled);
        assert.match(sentCode, /^\d{6}$/);
        await page.type('[data-report-email-verify] input', sentCode === '000000' ? '111111' : '000000');
        await click('[data-report-email-verify] button');
        await page.waitForFunction(() => document.querySelector('[data-report-email-result]').classList.contains('is-error') && !document.querySelector('[data-report-email-verify] input').disabled, { timeout: 10000 }).catch(async () => {
            await page.screenshot({ path: path.join(output, 'verification-failure.png'), fullPage: true });
            const detail = await page.evaluate(() => ({ path: location.pathname, result: document.querySelector('[data-report-email-result]')?.textContent, valid: document.querySelector('[data-report-email-verify]')?.checkValidity(), length: document.querySelector('[data-report-email-verify] input')?.value.length }));
            throw new Error(`Wrong-code interaction failed: ${JSON.stringify(detail)}`);
        });
        assert.equal((await Subscription.findOne().lean()).enabled, false);
        await page.$eval('[data-report-email-verify] input', (input, code) => { input.value = code; }, sentCode);
        await click('[data-report-email-verify] button');
        await page.waitForFunction(() => document.querySelector('[data-report-email-toggle]').checked && document.querySelector('[data-report-email-setup]').hidden);
        await page.reload({ waitUntil: 'networkidle2' });
        await ready();
        assert.equal(await page.$eval('[data-report-email-toggle]', input => input.checked), true);
        await click('[data-report-email-test]');
        await page.waitForFunction(() => document.querySelector('[data-report-email-result]').textContent.includes('تم إرسال الكشف التجريبي'), { timeout: 60000 });
        assert.equal(sentPdf.email, 'daily@example.com');
        assert.equal(sentPdf.pdf.subarray(0, 4).toString(), '%PDF');
        fs.writeFileSync(path.join(output, 'statement.pdf'), sentPdf.pdf);
        for (const width of [320, 390, 430, 1440]) {
            await page.setViewport({ width, height: 844 });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
        }
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
        await page.$eval('[data-report-email]', element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: path.join(output, 'verified-mobile.png') });
        await click('[data-report-email-toggle]');
        await page.waitForFunction(() => document.querySelector('[data-report-email-summary]').textContent.includes('الإرسال متوقف'));
        assert.equal((await Subscription.findOne().lean()).enabled, false);
        await click('[data-telegram-add]');
        await page.type('[data-telegram-add-form] input', 'هاتف المدير');
        await click('[data-telegram-add-form] button[type="submit"]');
        await page.waitForFunction(() => Boolean(document.querySelector('[data-telegram-code]').value));
        const linkingCode = await page.$eval('[data-telegram-code]', input => input.value);
        await page.$eval('[data-agent-telegram]', element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await page.screenshot({ path: path.join(output, 'telegram-link-mobile.png') });
        assert.equal(await page.$eval('[data-telegram-open]', anchor => anchor.href), `https://t.me/Ahrampay_bot?start=${linkingCode}`);
        const linked = await fetch(`${base}/webhooks/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }, body: JSON.stringify({ message: { text: `/start ${linkingCode}`, from: { id: 123456789, username: 'agency_manager', first_name: 'المدير' }, chat: { id: 123456789, type: 'private' } } }) });
        assert.equal(linked.status, 200);
        assert.equal((await TelegramConnection.findOne().lean()).enabled, true, 'Webhook must activate the named connection');
        await click('[data-telegram-check]');
        await page.waitForFunction(() => document.querySelector('.agent-telegram-card input[type="checkbox"]')?.checked && document.querySelector('[data-telegram-setup]').hidden, { timeout: 10000 }).catch(async () => {
            throw new Error('Telegram status UI: ' + await page.$eval('[data-agent-telegram]', node => node.textContent));
        });
        const firstId = String((await TelegramConnection.findOne({ name: 'هاتف المدير' }))._id);
        await click('[data-telegram-add]');
        await page.type('[data-telegram-add-form] input', 'حساب المحاسب');
        await click('[data-telegram-add-form] button[type="submit"]');
        await page.waitForFunction(() => Boolean(document.querySelector('[data-telegram-code]').value));
        const secondCode = await page.$eval('[data-telegram-code]', input => input.value);
        await fetch(`${base}/webhooks/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' }, body: JSON.stringify({ message: { text: `/start ${secondCode}`, from: { id: 987654321, username: 'agency_accountant', first_name: 'المحاسب' }, chat: { id: 987654321, type: 'private' } } }) });
        await click('[data-telegram-check]');
        await page.waitForFunction(() => document.querySelectorAll('.agent-telegram-card input[type="checkbox"]').length === 2 && document.querySelector('[data-telegram-setup]').hidden);
        const firstCard = `[data-telegram-connection-id="${firstId}"]`;
        await click(firstCard + ' input[type="checkbox"]');
        await page.waitForFunction(selector => !document.querySelector(selector + ' input[type="checkbox"]').checked && !document.querySelector(selector + ' input[type="checkbox"]').disabled, {}, firstCard);
        await page.$eval('[data-telegram-list]', element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.screenshot({ path: path.join(output, 'telegram-accounts-mobile.png') });
        const receipt = { transaction: { _id: new mongoose.Types.ObjectId(), tenantId: actor.tenantId, userId: actor.phone, status: 'completed', customId: 'ATT-UI-TEST', amount: 100 }, receiptUrl: 'https://example.test/test-receipt.png' };
        await telegram.sendReceipt(receipt); await telegram.sendReceipt(receipt);
        assert.equal(receiptPhotos, 1);
        await click(firstCard + ' [data-telegram-action="rename"]');
        await page.$eval(firstCard + ' [data-telegram-rename] input', input => { input.value = 'هاتف المدير الجديد'; });
        await click(firstCard + ' [data-telegram-rename] button[type="submit"]');
        await page.waitForFunction(selector => document.querySelector(selector + ' h4').textContent === 'هاتف المدير الجديد', {}, firstCard);
        await click(firstCard + ' input[type="checkbox"]');
        await page.waitForFunction(selector => document.querySelector(selector + ' input[type="checkbox"]').checked && !document.querySelector(selector + ' input[type="checkbox"]').disabled, {}, firstCard);
        await telegram.sendReceipt({ ...receipt, transaction: { ...receipt.transaction, _id: new mongoose.Types.ObjectId() } });
        assert.equal(receiptPhotos, 3);
        await click(firstCard + ' [data-telegram-action="remove"]');
        await page.waitForFunction(selector => !document.querySelector(selector), {}, firstCard);
        assert.equal(await TelegramConnection.countDocuments({ enabled: true, deletedAt: null }), 1);
        for (const width of [320, 390, 430, 1440]) {
            await page.setViewport({ width, height: 844 });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Telegram card overflow at ${width}`);
        }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ result: 'PASS', checks: ['CSRF', 'email verification', 'admin PDF', '320/390/430/1440px', 'named Telegram accounts', 'Ahrampay_bot activation link', 'two private /start bindings', 'independent pause', 'receipt fanout', 'rename', 'individual remove', 'no SMS', 'no JS errors'], output }));
    } finally {
        if (browser) await browser.close();
        await closeReportPdfBrowser();
        if (server) await new Promise(resolve => server.close(resolve));
        await mongoose.disconnect();
        await mongo.stop();
        global.fetch = originalFetch;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
