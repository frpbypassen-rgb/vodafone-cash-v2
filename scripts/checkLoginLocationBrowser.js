'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

async function main() {
    const app = express();
    app.set('views', path.join(__dirname, '../views'));
    app.set('view engine', 'ejs');
    app.use(express.static(path.join(__dirname, '../public')));
    app.get('/login', (req, res) => res.render('unified_login', {
        tenant: null, error: null, csrfToken: 'test-csrf', locationRequired: req.query.optional !== '1', clientPortal: true,
        accountMfaChallenge: req.query.mfa === '1', passwordResetEmailEnabled: false,
        passwordResetSupportPhone: '', passwordResetSupportEmail: ''
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844, isMobile: true });
        const errors = [];
        const posts = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.method() === 'POST') {
                posts.push(new URLSearchParams(request.postData()));
                return request.respond({ status: 200, contentType: 'text/html', body: '<p>Test submission captured</p>' });
            }
            if (!request.url().startsWith(base)) return request.abort();
            return request.continue();
        });
        await page.evaluateOnNewDocument(() => {
            window.geoRequests = [];
            Object.defineProperty(navigator, 'geolocation', { value: {
                getCurrentPosition(success, error) { window.geoRequests.push({ success, error }); }
            } });
        });
        const base = `http://127.0.0.1:${server.address().port}`;
        const open = query => page.goto(`${base}/login${query}`, { waitUntil: 'domcontentloaded' });
        const position = () => page.evaluate(() => window.geoRequests.at(-1).success({ coords: { latitude: 32.9, longitude: 13.2, accuracy: 30 } }));
        await open('');
        await page.type('#usernameInput', 'test-user');
        await page.type('#passwordInput', 'test-password');
        await page.$eval('#submitBtn', el => el.click());
        await new Promise(resolve => setTimeout(resolve, 4500));
        assert.equal(posts.length, 0, 'Slow GPS must not send credentials without location');
        await position();
        await page.waitForFunction(() => document.body.textContent.includes('Test submission captured'));
        assert.equal(posts[0].get('latitude'), '32.9');
        assert.equal(posts[0].get('username'), 'test-user');

        await open('');
        await page.type('#usernameInput', 'test-user');
        await page.type('#passwordInput', 'test-password');
        await page.evaluate(() => window.geoRequests[0].error({ code: 2 }));
        await page.$eval('#submitBtn', el => el.click());
        await page.evaluate(() => window.geoRequests.at(-1).error({ code: 2 }));
        await page.waitForFunction(() => !document.getElementById('submitBtn').disabled);
        assert.equal(posts.length, 1);
        assert.equal(await page.$eval('#passwordInput', el => el.value), 'test-password');
        await page.$eval('#locationRetryButton', el => el.click());
        await position();
        await page.$eval('#submitBtn', el => el.click());
        await page.waitForFunction(() => document.body.textContent.includes('Test submission captured'));

        await open('?mfa=1');
        await page.$eval('[data-auth-code-slot]', el => {
            const data = new DataTransfer();
            data.setData('text', '111111');
            el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
        });
        await new Promise(resolve => setTimeout(resolve, 800));
        assert.equal(posts.length, 2, 'MFA auto submit must await GPS');
        await page.evaluate(() => window.geoRequests.at(-1).error({ code: 1 }));
        await page.waitForFunction(() => !document.querySelector('[data-auth-submit]').disabled);
        assert.equal(posts.length, 2);
        await page.$eval('#locationRetryButton', el => el.click());
        await position();
        await page.waitForSelector('[data-auth-submit]', { visible: true, timeout: 2000 });
        await page.$eval('[data-auth-submit]', el => el.click());
        await page.waitForFunction(() => document.body.textContent.includes('Test submission captured'));
        assert.equal(posts[2].get('mfaToken'), '111111');
        assert.equal(posts[2].get('latitude'), '32.9');
        assert.deepEqual(errors, []);
        console.log('PASS: mobile login slow GPS, retry, preserved credentials, MFA auto submit and retry; no page errors.');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
