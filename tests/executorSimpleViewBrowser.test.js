'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const puppeteer = require('puppeteer');

jest.setTimeout(60000);

test('simple executor screen copies exact fields, accepts a task, and validates both completion and cancellation', async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
        const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'executor', 'dashboard-simple.ejs'), 'utf8');
        const html = ejs.render(source, {
            emp: { groupId: { name: 'منفذ تجريبي' } }, csrfToken: 'local-test-token'
        }).replace(/<link[^>]+fonts\.googleapis\.com[^>]*>/g, '')
            .replace(/<link[^>]+fonts\.gstatic\.com[^>]*>/g, '');
        await page.setContent(html);
        await page.addStyleTag({ path: path.join(__dirname, '..', 'public', 'css', 'executor', 'simple-dashboard.css') });
        await page.evaluate(() => {
            window.mockRequests = [];
            window.copiedText = '';
            window.mockTasks = [
                { _id: 'pending-1', customId: 'TEST-PENDING', status: 'processing', transferType: 'vodafone',
                    recipientNumber: '094', recipientPrefix: '094', recipientRevealed: false,
                    isOwnedByCurrentExecutor: false, amount: 125.5 },
                { _id: 'owned-1', customId: 'TEST-OWNED', status: 'accepted', transferType: 'vodafone',
                    recipientNumber: '0940719000', recipientPrefix: '094', recipientRevealed: true,
                    isOwnedByCurrentExecutor: true, amount: 72.25 },
                { _id: 'owned-2', customId: 'TEST-CANCEL', status: 'accepted', transferType: 'vodafone',
                    recipientNumber: '0911111111', recipientPrefix: '091', recipientRevealed: true,
                    isOwnedByCurrentExecutor: true, amount: 30 }
            ];
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
                writeText: async (value) => { window.copiedText = value; }
            } });
            window.fetch = async (url, options = {}) => {
                const method = options.method || 'GET';
                window.mockRequests.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
                if (method === 'POST' && url.includes('/accept-task/')) {
                    const task = window.mockTasks.find((item) => item._id === url.split('/').pop());
                    task.status = 'accepted'; task.recipientNumber = '0940777000';
                    task.recipientRevealed = true; task.isOwnedByCurrentExecutor = true;
                }
                if (method === 'POST' && (url.includes('/complete-task/') || url.includes('/cancel-task/'))) {
                    window.mockTasks = window.mockTasks.filter((task) => task._id !== url.split('/').pop());
                }
                const data = method === 'GET'
                    ? { success: true, simpleTaskViewEnabled: true, tasks: window.mockTasks,
                        completedTodaySummary: { count: 4, amount: 440.5 }, pollIntervalSeconds: 12 }
                    : { success: true };
                return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
            };
        });
        await page.addScriptTag({ path: path.join(__dirname, '..', 'public', 'js', 'executor-api.js') });
        await page.addScriptTag({ path: path.join(__dirname, '..', 'public', 'js', 'executor', 'simple-dashboard.js') });
        await page.waitForFunction(() => document.querySelectorAll('.simple-task').length === 3);
        if (process.env.EXECUTOR_SIMPLE_SCREENSHOT) {
            await page.screenshot({ path: process.env.EXECUTOR_SIMPLE_SCREENSHOT, fullPage: true });
        }

        expect(await page.$eval('#simpleCompletedCount', (node) => node.textContent)).toBe('4');
        expect(await page.$eval('#simpleCompletedAmount', (node) => node.textContent)).toContain('440.5');
        expect(await page.$eval('#simpleProofInput', (node) => ({ accept: node.accept, capture: node.hasAttribute('capture') })))
            .toEqual({ accept: 'image/*', capture: false });
        expect(await page.$eval('#simpleTasks', (node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        const pending = await page.$('.simple-task:nth-child(3)');
        expect(await pending.$eval('.simple-copy-actions button', (node) => node.disabled)).toBe(true);
        await pending.$eval('.simple-accept', (node) => node.click());
        await page.waitForFunction(() => document.querySelectorAll('.simple-task.is-active').length === 3);

        const owned = await page.$('.simple-task:nth-child(1)');
        await owned.$eval('.simple-copy-actions button:nth-child(1)', (node) => node.click());
        await page.waitForFunction(() => window.copiedText === '0940777000');
        await owned.$eval('.simple-copy-actions button:nth-child(2)', (node) => node.click());
        await page.waitForFunction(() => window.copiedText === '125.5');
        await owned.$eval('.simple-copy-actions button:nth-child(3)', (node) => node.click());
        await page.waitForFunction(() => window.copiedText.includes('رقم المستفيد: 0940777000'));

        await owned.$eval('.simple-success', (node) => node.click());
        await page.$eval('#simpleConfirmComplete', (node) => node.click());
        expect(await page.evaluate(() => window.mockRequests.filter((request) => request.url.includes('/complete-task/')).length)).toBe(0);
        await page.type('#simpleExecutionNumber', '12345');
        await page.$eval('#simpleConfirmComplete', (node) => node.click());
        await page.waitForFunction(() => window.mockRequests.some((request) => request.url.includes('/complete-task/')));
        expect(await page.evaluate(() => window.mockRequests.find((request) => request.url.includes('/complete-task/')).body.executionNumber)).toBe('12345');

        await page.waitForFunction(() => document.querySelectorAll('.simple-task').length === 2);
        await page.$eval('.simple-task:nth-child(1) .simple-danger', (node) => node.click());
        await page.select('#simpleCancelReason', 'لا توجد محفظة');
        await page.$eval('#simpleConfirmCancel', (node) => node.click());
        await page.waitForFunction(() => window.mockRequests.some((request) => request.url.includes('/cancel-task/')));
        expect(await page.evaluate(() => window.mockRequests.find((request) => request.url.includes('/cancel-task/')).body.reason)).toBe('لا توجد محفظة');
    } finally {
        await browser.close();
    }
});
