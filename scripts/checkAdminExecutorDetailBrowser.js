'use strict';

// Real EJS, CSS and page JavaScript with synthetic ledger data. No database, provider or financial writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const ejs = require('ejs');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const { adminHrefVisible } = require('../config/adminRoles');
const { normalizeExecutorDetailQuery } = require('../services/adminExecutorDetailService');

const root = path.join(__dirname, '..');
const rows = Array.from({ length: 8 }, (_, index) => ({
    _id: `row-${index + 1}`, customId: `DEMO-LEDGER-${index + 1}`, status: index % 3 ? 'completed' : 'deposit',
    service: 'vodafone', at: new Date(Date.UTC(2026, 10, 25, 10 - index, 30)),
    movement: index % 3 ? -(150 + index * 10) : 600 + index * 10,
    balanceBefore: 2000 - index * 100, balanceAfter: 1850 - index * 100,
    accountName: 'حساب تجريبي', vodafoneNumber: '0910000000', notes: 'معاينة فقط'
}));

async function run() {
    const bootstrapUrls = {
        css: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.rtl.min.css',
        js: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js'
    };
    const bootstrapAssets = {};
    for (const [type, url] of Object.entries(bootstrapUrls)) {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        assert.equal(response.ok, true, `Bootstrap ${type} fixture unavailable`);
        bootstrapAssets[type] = await response.text();
    }
    const render = search => {
        const filters = normalizeExecutorDetailQuery(Object.fromEntries(search));
        const tabRows = filters.tab === 'deposits' ? rows.filter(row => row.status === 'deposit')
            : filters.tab === 'operations' ? rows.filter(row => row.status === 'completed') : rows;
        const visible = filters.q ? tabRows.filter(row => row.customId.includes(filters.q)) : tabRows;
        return ejs.renderFile(path.join(root, 'views', 'executor_details.ejs'), {
            bot: { _id: 'fixture-executor', name: 'فريق التنفيذ التجريبي', status: 'active', serviceKey: 'vodafone', balance: -62850 },
            role: 'master', isMaster: true, adminName: 'اختبار الواجهة', csrfToken: 'fixture-only', query: {},
            history: { filters, rows: visible, total: visible.length, page: 1, totalPages: 1 },
            detailCounts: [{ _id: 'completed', count: 65 }, { _id: 'processing', count: 28 }],
            companyBalances: { totalBalance: -62850, multiService: false }, externalEmployees: [], otherExecutorMatches: [],
            executorServiceOptions: [{ key: 'vodafone', label: 'محافظ كاش', shortLabel: 'كاش' }], enabledServiceKeys: ['vodafone'],
            adminHrefVisible: href => adminHrefVisible('master', href)
        });
    };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/executor/fixture-executor') {
            try {
                const html = await render(url.searchParams);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
            } catch (error) { res.writeHead(500); return res.end(error.message); }
        }
        const file = path.resolve(root, 'public', '.' + decodeURIComponent(url.pathname));
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
        for (const [width, height] of [[1440, 900], [1140, 900], [390, 844]]) {
            await page.setViewport({ width, height });
            await page.goto(base + 'executor/fixture-executor?tab=ledger', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('.am-detail-record');
            assert.equal(await page.$$eval('.am-detail-record', elements => elements.length), 8);
            await page.click('.am-detail-record summary');
            assert.equal(await page.$eval('.am-detail-record', element => element.open), true);
            assert.match(await page.$eval('.am-detail-record dl', element => element.textContent), /الرصيد قبل الحركة/);
            await page.type('.am-detail-query input', 'DEMO-LEDGER-2');
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('.am-detail-filters button[type="submit"]')]);
            assert.equal(await page.$$eval('.am-detail-record', elements => elements.length), 1);
            assert.equal(await page.$eval('.am-detail-query input', element => element.value), 'DEMO-LEDGER-2');
            await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('.am-detail-clear')]);
            assert.equal(await page.$$eval('.am-detail-record', elements => elements.length), 8);
            assert.equal(await page.$eval('.am-detail-tabs [aria-current]', element => element.textContent.trim().includes('كشف الحساب')), true);
            assert.equal(await page.$$eval('.am-detail-tabs a', elements => elements.length), 5);
            assert.equal(await page.$eval('.am-detail-heading-actions a[href*="tab=operations"]', element => element.getAttribute('href')), '/executor/fixture-executor?tab=operations');
            if (width === 390) await page.evaluate(() => {
                document.documentElement.setAttribute('data-theme', 'dark');
                document.documentElement.setAttribute('data-bs-theme', 'dark');
            });
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
            assert.equal(overflow, false, `${width}px layout overflows horizontally`);
            const screenshot = path.join(os.tmpdir(), `ahram-executor-detail-${width}.png`);
            await page.screenshot({ path: screenshot, fullPage: true });
            await page.goto(base + 'executor/fixture-executor?tab=operations', { waitUntil: 'domcontentloaded' });
            assert.equal(await page.$$eval('.am-detail-record', elements => elements.length), 5);
            await page.goto(base + 'executor/fixture-executor?tab=deposits', { waitUntil: 'domcontentloaded' });
            assert.equal(await page.$$eval('.am-detail-record', elements => elements.length), 3);
            assert.equal(await page.$eval('#settlementForm', element => element.action.endsWith('/executor/fixture-executor/settle')), true);
            process.stdout.write(JSON.stringify({ width, theme: width === 390 ? 'dark' : 'light', rows: 8, search: 'pass', details: 'pass', overflow, screenshot }) + '\n');
        }
        assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
