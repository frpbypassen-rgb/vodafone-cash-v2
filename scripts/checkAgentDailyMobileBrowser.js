'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const express = require('express');
const { renderAgentPage } = require('../tests/helpers/agentPortalFixtures');
const { loadPuppeteer } = require('../utils/puppeteerLoader');

const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=',
    'base64'
);
const ids = [1, 2, 3, 4, 5].map((value) => `64b00000000000000000000${value}`);
const transactions = ids.map((id, index) => ({
    _id: id,
    customId: `ATT-2610-2500${index + 1}`,
    status: index === 1 ? 'processing' : 'completed',
    transferType: index === 4 ? 'bank_account' : 'vodafone',
    accountName: index === 0 ? 'محمد أحمد — حساب المستفيد' : 'مستفيد الاختبار',
    vodafoneNumber: '01012345678',
    employeeName: 'موظف الوكالة',
    subAccountName: 'مكتب طرابلس',
    amount: index === 0 ? 1000.5 : 2500,
    costLYD: 206.289,
    createdAt: new Date(),
    hasProof: index !== 1,
    receiptImages: index === 1 ? [] : [{ url: `/client/proxy/image/${id}/0`, label: 'صورة العملية' }],
}));

async function main() {
    const output = process.argv[2] || path.resolve(__dirname, '../../outputs/agent-daily-mobile');
    fs.mkdirSync(output, { recursive: true });
    const app = express();
    app.use(express.static(path.join(__dirname, '../public')));
    app.get('/preview/:role/:theme', async (req, res) =>
        res.send(
            await renderAgentPage('transactions', req.params.role, {
                transactions,
                total: transactions.length,
                clientTheme: req.params.theme,
                summary: {
                    totalCount: 5,
                    completedCount: 4,
                    pendingCount: 1,
                    cancelledCount: 0,
                    totalEGP: 11000.5,
                },
            })
        )
    );
    let proofFetches = 0;
    app.get('/agent-portal/proxy/image/:id/:index', (req, res) => {
        proofFetches += 1;
        if (req.params.id === ids[2]) return res.status(401).json({ error: 'expired' });
        if (req.params.id === ids[3]) return res.type('html').send('<html>Login</html>');
        if (req.params.id === ids[4])
            return res
                .type('image/svg+xml')
                .send(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><text x="50" y="80">Test receipt</text></svg>'
                );
        return res.type('png').send(png);
    });
    app.get('/agent-portal/transactions/:id/details', (req, res) =>
        res.json({
            success: true,
            transaction: {
                ...transactions[0],
                receiptImages: [{ url: `/client/proxy/image/${ids[0]}/0`, label: 'صورة العملية' }],
                statusLabel: 'ناجحة',
                serviceLabel: 'محافظ كاش',
                destination: '01012345678',
            },
        })
    );
    app.use((_req, res) =>
        res.json({ success: true, notifications: [], unreadCount: 0, notes: [], enabled: false })
    );
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    let checks = 0;
    try {
        const puppeteer = await loadPuppeteer();
        browser = await puppeteer.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            headless: true,
        });
        for (const [width, role, theme] of [
            [320, 'owner', 'day'],
            [390, 'owner', 'night'],
            [430, 'employee', 'day'],
            [1440, 'owner', 'day'],
        ]) {
            const page = await browser.newPage();
            const click = async (selector) => {
                await page.$eval(selector, (node) =>
                    node.scrollIntoView({ block: 'center', behavior: 'instant' })
                );
                await page.click(selector);
            };
            const errors = [];
            const receiptRequests = [];
            page.on('response', (response) => {
                if (response.url().includes('/proxy/image/'))
                    receiptRequests.push([response.url(), response.status()]);
            });
            page.on('pageerror', (error) => errors.push(error.message));
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                if (!request.url().startsWith(origin) || request.url().includes('/socket.io/')) {
                    return request.respond({
                        status: 200,
                        contentType:
                            request.resourceType() === 'script' ? 'application/javascript' : 'text/css',
                        body: '',
                    });
                }
                return request.continue();
            });
            await page.evaluateOnNewDocument(() => {
                window.testShares = [];
                Object.defineProperty(navigator, 'userActivation', {
                    configurable: true,
                    value: { isActive: true },
                });
                Object.defineProperty(navigator, 'canShare', {
                    configurable: true,
                    value: ({ files }) => files.length === 1,
                });
                Object.defineProperty(navigator, 'share', {
                    configurable: true,
                    value: async (data) => {
                        if (window.testShareError) throw new DOMException('test', window.testShareError);
                        window.testShares.push({
                            name: data.files[0].name,
                            type: data.files[0].type,
                            size: data.files[0].size,
                            url: data.url || null,
                        });
                    },
                });
                window.Swal = { fire: async () => ({ isConfirmed: false }) };
            });
            await page.setViewport({ width, height: 950, deviceScaleFactor: 1 });
            await page.goto(`${origin}/preview/${role}/${theme}`, { waitUntil: 'networkidle2' });
            await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
            const layout = await page.evaluate(() => ({
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                cards: getComputedStyle(document.querySelector('.agent-daily-list')).display !== 'none',
                table:
                    getComputedStyle(document.querySelector('.agent-desktop-transactions')).display !==
                    'none',
                dates: document.querySelectorAll('input[type=date]').length,
                costs: [...document.querySelectorAll('.agent-daily-meta dt')].filter(
                    (node) => node.textContent === 'التكلفة'
                ).length,
            }));
            assert.equal(layout.overflow, false, `Overflow at ${width}`);
            assert.equal(layout.cards, width < 768);
            assert.equal(layout.table, width >= 768);
            assert.equal(layout.dates, 0);
            if (role === 'employee') assert.equal(layout.costs, 0);
            if (width < 768) {
                const amountHeight = await page.$eval(
                    '.agent-daily-amount strong',
                    (node) => node.getBoundingClientRect().height
                );
                assert.ok(amountHeight < 40, 'Amounts must stay readable on one line');
            }
            await page.screenshot({
                path: path.join(output, `transactions-${role}-${theme}-${width}-preview.png`),
                fullPage: false,
            });
            if (width < 768) {
                const firstShare = `.agent-daily-card[data-daily-transaction="${ids[0]}"] [data-agent-share-receipt]`;
                await click(firstShare);
                await page.waitForFunction(() => window.testShares.length === 1);
                assert.deepEqual(await page.evaluate(() => window.testShares[0]), {
                    name: 'receipt-ATT-2610-25001.png',
                    type: 'image/png',
                    size: png.length,
                    url: null,
                });
                await click(`.agent-daily-card[data-daily-transaction="${ids[0]}"] [data-receipt-lightbox]`);
                assert.equal(await page.$eval('#receiptLightbox', (node) => node.open), true);
                await click('#agentLightboxShare');
                await page.waitForFunction(() => window.testShares.length === 2);
                await click('#receiptLightbox [data-lightbox-close]');
                for (const id of [ids[2], ids[3]]) {
                    await click(
                        `.agent-daily-card[data-daily-transaction="${id}"] [data-agent-share-receipt]`
                    );
                    await page
                        .waitForFunction(
                            (id) =>
                                !document.querySelector(
                                    `[data-daily-transaction="${id}"] [data-agent-share-receipt]`
                                ).disabled,
                            {},
                            id
                        )
                        .catch(async (error) => {
                            console.error(
                                JSON.stringify({
                                    width,
                                    role,
                                    receiptRequests,
                                    button: await page.$eval(
                                        `[data-daily-transaction="${id}"]`,
                                        (node) => node.outerHTML
                                    ),
                                })
                            );
                            throw error;
                        });
                    assert.equal(
                        await page.evaluate(() => window.testShares.length),
                        2,
                        'Never share HTML or an expired receipt'
                    );
                }
                await click(
                    `.agent-daily-card[data-daily-transaction="${ids[4]}"] [data-agent-share-receipt]`
                );
                await page.waitForFunction(() => window.testShares.length === 3);
                assert.equal(
                    await page.evaluate(() => window.testShares[2].type),
                    'image/png',
                    'SVG receipts become WhatsApp-compatible PNG files'
                );
                await page.evaluate(() => {
                    window.testShareError = 'AbortError';
                });
                await click(firstShare);
                await page.waitForFunction(
                    (selector) => !document.querySelector(selector).disabled,
                    {},
                    firstShare
                );
                assert.equal(
                    await page.$eval('.agent-daily-card .agent-share-status', (node) => node.textContent),
                    ''
                );
                if (width === 320) {
                    const fetchesBefore = proofFetches;
                    await page.evaluate(() => {
                        window.testShareError = 'NotAllowedError';
                    });
                    await click(firstShare);
                    await page.waitForFunction(
                        (selector) => !document.querySelector(selector).disabled,
                        {},
                        firstShare
                    );
                    assert.ok(
                        (
                            await page.$eval(
                                '.agent-daily-card .agent-share-status',
                                (node) => node.textContent
                            )
                        ).includes('جاهزة')
                    );
                    await page.evaluate(() => {
                        window.testShareError = null;
                        navigator.userActivation.isActive = false;
                    });
                    await click(firstShare);
                    await page.waitForFunction(
                        (selector) => !document.querySelector(selector).disabled,
                        {},
                        firstShare
                    );
                    assert.equal(await page.evaluate(() => window.testShares.length), 3);
                    await page.evaluate(() => {
                        navigator.userActivation.isActive = true;
                    });
                    await click(firstShare);
                    await page.waitForFunction(() => window.testShares.length === 4);
                    assert.equal(proofFetches, fetchesBefore, 'Retry reuses the prepared file');
                    await page.$eval(firstShare, (node) => {
                        node.dataset.receiptUrl = 'https://evil.invalid/private.png';
                    });
                    await click(firstShare);
                    await page.waitForFunction(
                        (selector) => !document.querySelector(selector).disabled,
                        {},
                        firstShare
                    );
                    assert.equal(await page.evaluate(() => window.testShares.length), 4);
                    await page.$eval(
                        firstShare,
                        (node, id) => {
                            node.dataset.receiptUrl = '/agent-portal/proxy/image/' + id + '/0';
                        },
                        ids[0]
                    );
                    checks += 4;
                }
                await page.evaluate(() => {
                    window.testShareError = null;
                    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
                    window.testDownloads = [];
                    HTMLAnchorElement.prototype.click = function () {
                        window.testDownloads.push(this.download);
                    };
                });
                await click(firstShare);
                await page.waitForFunction(() => window.testDownloads.length === 1);
                assert.equal(
                    await page.evaluate(() => window.testDownloads[0]),
                    'receipt-ATT-2610-25001.png'
                );
                await page.screenshot({
                    path: path.join(output, `transactions-${role}-${theme}-${width}.png`),
                    fullPage: true,
                });
                checks += 8;
            }
            assert.deepEqual(errors, []);
            checks += 1;
            await page.close();
        }
        fs.writeFileSync(
            path.join(output, 'results.json'),
            JSON.stringify({ result: 'PASS', checks, proofFetches }, null, 2)
        );
        console.log(JSON.stringify({ result: 'PASS', checks, output }));
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
