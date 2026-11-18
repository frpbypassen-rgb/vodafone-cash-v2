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
        const errors = [];
        const posts = [];
        const base = `http://127.0.0.1:${server.address().port}`;
        let context, page;
        const open = async query => {
            // Each scenario represents an independent login attempt. Reusing a
            // page after a simulated successful password POST can carry
            // browser-managed form state into the next scenario's typing.
            if (context) await context.close();
            context = await browser.createBrowserContext();
            page = await context.newPage();
            await page.setViewport({ width: 390, height: 844, isMobile: true });
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
                window.clearedGeoWatches = [];
                Object.defineProperty(navigator, 'geolocation', { value: {
                    getCurrentPosition(success, error, options) { window.geoRequests.push({ success, error, options, kind: 'current' }); },
                    watchPosition(success, error, options) {
                        const id = window.geoRequests.length + 1;
                        window.geoRequests.push({ success, error, options, kind: 'watch', id });
                        return id;
                    },
                    clearWatch(id) { window.clearedGeoWatches.push(id); }
                } });
            });
            await page.goto(`${base}/login${query}`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.loginLocation && window.geoRequests.length > 0);
        };
        const enterCredentials = async () => {
            await page.type('#usernameInput', 'test-user');
            await page.type('#passwordInput', 'test-password');
            // Distinguish a browser-fixture setup failure from the GPS code
            // clearing a correctly entered credential later in the attempt.
            assert.equal(await page.$eval('#usernameInput', el => el.value), 'test-user');
            assert.equal(await page.$eval('#passwordInput', el => el.value), 'test-password');
        };
        const position = () => page.evaluate(() => window.geoRequests.at(-1).success({ coords: { latitude: 32.9, longitude: 13.2, accuracy: 30 } }));
        await open('');
        await enterCredentials();
        await page.$eval('#submitBtn', el => el.click());
        await new Promise(resolve => setTimeout(resolve, 4500));
        assert.equal(posts.length, 0, 'Slow GPS must not send credentials without location');
        await position();
        await page.waitForFunction(() => document.body.textContent.includes('Test submission captured'));
        assert.equal(posts[0].get('latitude'), '32.9');
        assert.equal(posts[0].get('username'), 'test-user');
        assert.equal(posts[0].get('password'), 'test-password');

        await open('');
        await enterCredentials();
        await page.evaluate(() => window.geoRequests[0].error({ code: 2 }));
        assert.equal(await page.evaluate(() => window.geoRequests.at(-1).kind), 'watch');
        assert.equal(await page.evaluate(() => window.geoRequests.at(-1).options.enableHighAccuracy), true);
        await page.$eval('#submitBtn', el => el.click());
        await page.evaluate(() => window.geoRequests.at(-1).error({ code: 2 }));
        assert.equal(posts.length, 1, 'A recoverable GPS-watch error must not submit credentials');
        assert.equal(await page.$eval('#submitBtn', el => el.disabled), true);
        await page.evaluate(() => window.geoRequests.at(-1).error({ code: 1 }));
        await page.waitForFunction(() => !document.getElementById('submitBtn').disabled);
        assert.equal(posts.length, 1);
        assert.equal(await page.$eval('#passwordInput', el => el.value), 'test-password');
        assert.deepEqual(await page.evaluate(() => window.clearedGeoWatches), [2]);
        await page.$eval('#locationRetryButton', el => el.click());
        await position();
        await page.$eval('#submitBtn', el => el.click());
        await page.waitForFunction(() => document.body.textContent.includes('Test submission captured'));
        assert.equal(posts[1].get('username'), 'test-user');
        assert.equal(posts[1].get('password'), 'test-password');
        assert.equal(posts[1].get('latitude'), '32.9');

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

        await open('?optional=1');
        await enterCredentials();
        await page.$eval('#submitBtn', el => el.click());
        await page.evaluate(() => window.geoRequests.at(-1).error({ code: 2 }));
        await page.waitForFunction(() => document.body.textContent.includes('Test submission captured'));
        assert.equal(posts.length, 4);
        assert.equal(posts[3].get('latitude'), '');
        assert.equal(posts[3].get('username'), 'test-user');
        assert.equal(posts[3].get('password'), 'test-password');
        assert.deepEqual(errors, []);
        console.log('PASS: isolated mobile logins: slow GPS, GPS-watch recovery/denial, retry, preserved and posted credentials, MFA auto submit/retry, optional location; no page errors.');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
