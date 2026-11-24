'use strict';

// Browser fixture: real EJS/CSS/directory JavaScript, synthetic executor rows, no database or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const ejs = require('ejs');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const { adminHrefVisible } = require('../config/adminRoles');

const root = path.join(__dirname, '..');
const today = new Date('2026-11-25T08:00:00Z');
const bots = [
    { _id: 'manual-1', name: 'منفذ طرابلس', status: 'active', balance: 8200, serviceLabel: 'محافظ كاش', serviceKey: 'vodafone', txCount: 42 },
    { _id: 'api-1', name: 'كنان التجريبي', status: 'active', isApiBot: true, apiProviderKey: 'kenan', serviceLabel: 'محافظ كاش', liveApiServiceCredit: 2300, liveApiBalanceCheckedAt: today, txCount: 16 },
    { _id: 'manual-2', name: 'منفذ بنغازي', status: 'inactive', balance: -120, serviceLabel: 'حساب بنكي', serviceKey: 'bank_account', txCount: 4 },
    { _id: 'manager-1', name: 'مجموعة الإشراف', status: 'active', isManagerBot: true, serviceLabel: 'خدمات التنفيذ', balance: 0, txCount: 6 }
];
const archivedBots = [{ _id: 'archive-1', name: 'المنفذ السابق', status: 'archived', serviceLabel: 'محافظ كاش', balance: 75, txCount: 3 }];

async function run() {
    const bootstrapUrls = {
        css: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.rtl.min.css',
        js: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js'
    };
    const bootstrapAssets = {};
    for (const [type, url] of Object.entries(bootstrapUrls)) {
        const response = await fetch(url);
        assert.equal(response.ok, true, `Bootstrap ${type} fixture unavailable`);
        bootstrapAssets[type] = await response.text();
    }
    const html = await ejs.renderFile(path.join(root, 'views', 'executors.ejs'), {
        bots, archivedBots, isMaster: true, role: 'master', adminName: 'اختبار الواجهة',
        csrfToken: 'fixture-only', query: {},
        executorRegistrationUrl: 'https://example.test/register', executorLoginUrl: 'https://example.test/login',
        executorServiceOptions: [{ key: 'vodafone', label: 'محافظ كاش', shortLabel: 'كاش' }],
        apiProviderPresets: [{ key: 'kenan', nameAr: 'كنان', apiUrl: 'https://example.test', serviceId: '', providerId: '', fieldId: '', machineSerial: '' }],
        adminHrefVisible: href => adminHrefVisible('master', href)
    });
    const server = http.createServer((req, res) => {
        if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
        const asset = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = path.resolve(root, 'public', '.' + asset);
        if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404); return res.end();
        }
        res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await (await loadPuppeteer()).launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) return request.continue();
            if (request.url() === bootstrapUrls.css) return request.respond({ status: 200, contentType: 'text/css', body: bootstrapAssets.css });
            if (request.url() === bootstrapUrls.js) return request.respond({ status: 200, contentType: 'text/javascript', body: bootstrapAssets.js });
            return request.respond({ status: 200, contentType: request.url().endsWith('.css') ? 'text/css' : 'text/javascript', body: '' });
        });
        const base = `http://127.0.0.1:${server.address().port}/`;
        for (const [width, height] of [[1440, 900], [390, 844]]) {
            await page.setViewport({ width, height });
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-executor-result]');
            await page.evaluate(() => {
                window.fixtureClipboard = '';
                window.Swal = { fire: async () => ({ isConfirmed: false }) };
                Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.fixtureClipboard = value; } } });
            });
            assert.match(await page.$eval('[data-executor-result]', el => el.textContent), /4 حساب/);
            assert.equal(await page.$$eval('#current-executors-pane [data-executor-card]:not([hidden])', els => els.length), 4);
            assert.equal(await page.$eval('#current-executors-pane .am-card-open', el => el.getAttribute('href')), '/executor/manual-1');
            await page.click('.am-executor-access > summary');
            await page.click('[onclick*="executorRegistrationUrl"]');
            assert.equal(await page.evaluate(() => window.fixtureClipboard), 'https://example.test/register');
            await page.click('.am-executor-access > summary');
            await page.type('[data-executor-search]', 'كنان');
            assert.equal(await page.$$eval('#current-executors-pane [data-executor-card]:not([hidden])', els => els.length), 1);
            await page.select('[data-executor-status]', 'stopped');
            assert.equal(await page.$$eval('#current-executors-pane [data-executor-card]:not([hidden])', els => els.length), 0);
            await page.click('[data-executor-reset]');
            assert.equal(await page.$$eval('#current-executors-pane [data-executor-card]:not([hidden])', els => els.length), 4);
            await page.select('[data-executor-status]', 'active');
            await page.click('#archived-executors-tab');
            await page.waitForFunction(() => document.querySelector('#archived-executors-pane').classList.contains('active'));
            assert.equal(await page.$eval('[data-executor-status]', el => el.disabled), true);
            assert.equal(await page.$$eval('#archived-executors-pane [data-executor-card]:not([hidden])', els => els.length), 1);
            await page.click('#current-executors-tab');
            await page.waitForFunction(() => document.querySelector('#current-executors-pane').classList.contains('active'));
            await page.select('[data-executor-status]', 'all');
            await page.click('[data-bs-target="#createExecutorModal"]');
            await page.waitForSelector('#createExecutorModal.show');
            await page.select('#botType', 'api');
            assert.equal(await page.$eval('#humanLoginFields .human-required', el => el.disabled), true);
            assert.equal(await page.$eval('#apiFields', el => el.classList.contains('d-none')), false);
            await page.click('#createExecutorModal [data-bs-dismiss="modal"]');
            await page.waitForFunction(() => !document.querySelector('#createExecutorModal').classList.contains('show'));
            if (width === 390) await page.evaluate(() => {
                document.documentElement.setAttribute('data-theme', 'dark');
                document.documentElement.setAttribute('data-bs-theme', 'dark');
            });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
            assert.equal(overflow, false, `${width}px layout overflows horizontally`);
            const screenshot = path.join(os.tmpdir(), `ahram-executors-${width}.png`);
            await page.screenshot({ path: screenshot, fullPage: true });
            process.stdout.write(JSON.stringify({ width, theme: width === 390 ? 'dark' : 'light', visibleAfterReset: 4, archivedVisible: 1, modalOpened: true, overflow, screenshot }) + '\n');
        }
        assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
