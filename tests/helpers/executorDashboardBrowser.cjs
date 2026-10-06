'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { portalAssets } = require('./executorPortalSources');

async function main() {
    const { default: puppeteer } = await import('puppeteer');
    const root = path.join(__dirname, '../..');
    const scenarios = JSON.parse(fs.readFileSync(0, 'utf8'));
    const html = await ejs.renderFile(path.join(root, 'views/executor/dashboard.ejs'), {
        activeTaskId: null,
        csrfToken: 'ui-regression-token',
        emp: { _id: 'executor-ui-test', name: 'Executor', role: 'manager', groupId: { name: 'UI test', balance: 5000 } },
        companyBalances: null
    });
    const scripts = new Map(['executor-api', 'executor-workspace'].map((name) => [
        `/js/${name}.js`, fs.readFileSync(path.join(root, `public/js/${name}.js`), 'utf8')
    ]));
    for (const asset of portalAssets(html).filter((file) => file.endsWith('.js'))) {
        scripts.set(`/${asset.slice('public/'.length)}`, fs.readFileSync(path.join(root, asset), 'utf8'));
    }
    const browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || await puppeteer.executablePath(),
        headless: true,
        pipe: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const results = [];
    try {
        for (const scenario of scenarios) {
            const page = await browser.newPage();
            const errors = [];
            const apiRequests = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.evaluateOnNewDocument(() => {
                window.__executorXssHits = 0;
                window.__executorDialogs = [];
                HTMLMediaElement.prototype.play = () => Promise.resolve();
                HTMLMediaElement.prototype.pause = () => {};
                // Parse dialog HTML in Chrome without contacting SweetAlert's CDN.
                window.Swal = {
                    async fire(options) {
                        window.__executorDialogs.push(options);
                        const dialog = document.createElement('div');
                        dialog.className = 'ui-test-dialog';
                        dialog.innerHTML = options.html || '';
                        document.body.appendChild(dialog);
                        return { isConfirmed: true };
                    }
                };
            });
            await page.setRequestInterception(true);
            page.on('request', async (request) => {
                const url = new URL(request.url());
                if (url.hostname === 'executor-ui.test') {
                    if (url.pathname === '/executor-portal/dashboard') {
                        await request.respond({ status: 200, contentType: 'text/html', body: html });
                        return;
                    }
                    if (scripts.has(url.pathname)) {
                        await request.respond({ status: 200, contentType: 'text/javascript', body: scripts.get(url.pathname) });
                        return;
                    }
                    if (url.pathname.startsWith('/executor-portal/api/')) {
                        apiRequests.push({
                            path: url.pathname + url.search, method: request.method(),
                            csrf: request.headers()['x-csrf-token'] || null,
                            body: request.postData() || null
                        });
                        const data = url.pathname === '/executor-portal/api/live-tasks' ? scenario.data : { success: true };
                        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
                        return;
                    }
                }
                // All third-party assets and attack URLs are blocked, not fetched.
                await request.abort();
            });
            try {
                await page.goto('http://executor-ui.test/executor-portal/dashboard', { waitUntil: 'load' });
                await page.waitForFunction(() => document.querySelector('#tasksList .executor-empty-state-live'));
                if (scenario.apiLog) {
                    await page.evaluate((log) => window.showApiLogFromText(encodeURIComponent(log)), scenario.apiLog);
                }
                // A positive control proves that injected event handlers execute in this harness.
                const controlHits = await page.evaluate(async () => {
                    const control = document.createElement('div');
                    control.innerHTML = '<img src="/xss-control" onerror="window.__executorControlHits = 1">';
                    document.body.appendChild(control);
                    await new Promise((resolve) => {
                        control.firstChild.addEventListener('error', resolve, { once: true });
                    });
                    control.remove();
                    return window.__executorControlHits || 0;
                });
                const dom = await page.evaluate(() => {
                    const inspect = (element) => ({
                        text: element.textContent,
                        html: element.innerHTML,
                        unsafeElements: element.querySelectorAll('img, svg, script, iframe, [onerror], [onload]').length
                    });
                    const emergency = document.getElementById('emergencyMessage');
                    const completed = document.getElementById('completedTasksList');
                    return {
                        xssHits: window.__executorXssHits,
                        emergency: {
                            ...inspect(emergency),
                            code: emergency.querySelector('code')?.textContent || null,
                            codeStyle: emergency.querySelector('code')?.getAttribute('style') || null,
                            breaks: emergency.querySelectorAll('br').length,
                            overlay: document.getElementById('emergencyOverlay').style.display
                        },
                        completed: {
                            ...inspect(completed),
                            rows: Array.from(completed.children).map((row) => ({
                                id: row.querySelector('.text-main')?.textContent || null,
                                recipient: row.querySelector('small[dir="ltr"]')?.textContent || null,
                                amount: row.querySelector('.text-success')?.textContent || null,
                                badge: row.querySelector('.badge')?.textContent.trim() || null,
                                icon: row.querySelector('.badge i')?.className || null
                            })),
                            count: document.getElementById('completedCount').textContent,
                            sum: document.getElementById('completedSum').textContent
                        },
                        dialogs: Array.from(document.querySelectorAll('.ui-test-dialog')).map(inspect),
                        dialogOptions: window.__executorDialogs,
                        boardError: !document.getElementById('taskBoardStatus').hidden
                    };
                });
                results.push({ name: scenario.name, ...dom, errors, apiRequests, controlHits });
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
    process.stdout.write(JSON.stringify(results));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
