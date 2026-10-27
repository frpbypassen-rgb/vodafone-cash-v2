'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Company = require('../models/ClientCompany');
const CompanyEmployee = require('../models/ClientEmployee');
const TrustedDevice = require('../models/TrustedDevice');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const { assertLocalSeedTarget } = require('./lib/productionDatabaseGuard');
const totp = (secret, offset = 0) => {
    let bits = 0,
        value = 0;
    const bytes = [];
    for (const char of secret) {
        value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
    const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
    return String((hmac.readUInt32BE(hmac[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
};
async function main() {
    const target = assertLocalSeedTarget(process.env);
    if (target.databaseName !== 'ahram_company_mobile_demo_v2')
        throw new Error('Only the isolated local preview database is supported.');
    const base = 'http://127.0.0.1:4577';
    const companyMode = process.argv.includes('--company');
    const AccountModel = companyMode ? CompanyEmployee : User;
    const portal = companyMode ? '/client' : '/agent-portal';
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    const password = crypto.randomBytes(20).toString('hex');
    const username = 'mfa-flow-' + crypto.randomBytes(8).toString('hex') + '@example.test';
    let browser, account, company;
    try {
        if (companyMode)
            company = await Company.create({ name: 'شركة اختبار إعداد المصادقة', status: 'active' });
        account = await AccountModel.create({
            name: 'حساب اختبار إعداد المصادقة',
            role: companyMode ? 'owner' : 'agent',
            ...(company ? { companyId: company._id } : {}),
            webUsername: username,
            webPassword: password,
            status: 'active',
        });
        browser = await (
            await loadPuppeteer()
        ).launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
        const page = await browser.newPage();
        const errors = [];
        let secret;
        const click = async (selector) => {
            await page.$eval(selector, (el) => el.scrollIntoView({ block: 'center' }));
            await page.locator(selector).click();
        };
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('dialog', (dialog) => dialog.accept(dialog.type() === 'prompt' ? totp(secret) : undefined));
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.setRequestInterception(true);
        page.on('request', (req) =>
            req.url().startsWith(base) ||
            req.url().startsWith('data:') ||
            req.url().startsWith('blob:' + base + '/')
                ? req.continue()
                : req.abort()
        );
        await page.goto(base + '/login?portal=client', { waitUntil: 'domcontentloaded' });
        await page.type('#usernameInput', username);
        await page.type('#passwordInput', password);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.$eval('#loginForm', (form) => form.requestSubmit()),
        ]);
        const open = async () => {
            if (page.url().startsWith(base + portal + '/security'))
                await page.reload({ waitUntil: 'domcontentloaded' });
            else await page.goto(base + portal + '/security#companyMfa', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
            for (const id of ['companyWelcomeDialog', 'companyLowBalanceDialog', 'companyMessageDialog']) {
                if (await page.$eval('#' + id, (el) => el.open).catch(() => false))
                    await click('#' + id + ' [data-dialog-close]');
            }
        };
        await open();
        await page.waitForFunction(() =>
            document.querySelector('[data-mfa-state]')?.classList.contains('warn')
        );
        await click('[data-mfa-start]');
        await page.waitForSelector('[data-mfa-setup]:not([hidden])');
        secret = await page.$eval('[data-mfa-secret]', (el) => el.textContent);
        assert.match(secret, /^[A-Z2-7]{20}$/);
        const appLink = await page.$eval('[data-mfa-open-app]', (el) => el.href);
        assert.equal(new URL(appLink).protocol, 'otpauth:');
        assert.equal(new URL(appLink).searchParams.get('secret'), secret);
        await click('[data-mfa-method]:first-child summary');
        await page.waitForFunction(() => {
            const img = document.querySelector('[data-mfa-qr-image]');
            return img.complete && img.naturalWidth > 0;
        });
        await click('[data-mfa-method]:last-child summary');
        assert.equal(await page.$eval('[data-mfa-method]:first-child', (el) => el.open), false);
        await open();
        await page.waitForSelector('[data-mfa-setup]:not([hidden])');
        assert.equal(
            await page.$eval('[data-mfa-secret]', (el) => el.textContent),
            secret,
            'Reload must resume the same pending setup'
        );
        fs.mkdirSync('outputs/mfa-enrollment-browser', { recursive: true });
        for (const theme of ['day', 'night'])
            for (const width of [320, 390, 430]) {
                await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
                await page.evaluate((value) => {
                    document.documentElement.dataset.theme = value;
                    document.body.dataset.theme = value;
                }, theme);
                assert.equal(
                    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
                    false
                );
                if (width === 390)
                    await (
                        await page.$('[data-mfa-panel]')
                    ).screenshot({ path: `outputs/mfa-enrollment-browser/${theme}-add.png` });
            }
        await click('[data-mfa-next]');
        const validCodes = new Set([-1, 0, 1].map((offset) => totp(secret, offset)));
        let invalid = '000000';
        while (validCodes.has(invalid)) invalid = String(Number(invalid) + 1).padStart(6, '0');
        await page.type('[data-mfa-confirm-token]', invalid);
        await click('[data-mfa-confirm]');
        await page.waitForFunction(() =>
            document.querySelector('[data-mfa-message]').textContent.includes('غير صحيح')
        );
        assert.equal((await AccountModel.findById(account._id).lean()).mfaEnabled, false);
        assert.equal(await page.$eval('[data-mfa-confirm-step]', (el) => el.hidden), false);
        await page.$eval('[data-mfa-confirm-token]', (el) => {
            el.value = '';
        });
        await page.type('[data-mfa-confirm-token]', totp(secret));
        await click('[data-mfa-confirm]');
        await page.waitForSelector('[data-mfa-recovery-step]:not([hidden])');
        const codes = await page.$eval('[data-mfa-recovery]', (el) => el.value.split('\n'));
        assert.equal(codes.length, 8);
        assert.equal(await page.$eval('[data-mfa-secret]', (el) => el.textContent), '');
        await open();
        await page.waitForSelector('[data-mfa-recovery-step]:not([hidden])');
        assert.deepEqual(await page.$eval('[data-mfa-recovery]', (el) => el.value.split('\n')), codes);
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                    writeText: async (text) => {
                        window.testCopiedRecovery = text;
                    },
                },
            });
            const createObjectURL = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (blob) => {
                blob.text().then((text) => {
                    window.testDownloadedRecovery = text;
                });
                return createObjectURL(blob);
            };
            document.addEventListener(
                'click',
                (event) => {
                    const link = event.target.closest('a[download]');
                    if (link) event.preventDefault();
                },
                true
            );
        });
        await click('[data-mfa-copy-recovery]');
        assert.equal(await page.evaluate(() => window.testCopiedRecovery), codes.join('\n'));
        await click('[data-mfa-download-recovery]');
        await page.waitForFunction(() => typeof window.testDownloadedRecovery === 'string');
        assert((await page.evaluate(() => window.testDownloadedRecovery)).includes(codes.join('\n')));
        await click('[data-mfa-finish]');
        await page.waitForFunction(() => document.querySelector('[data-mfa-recovery-step]').hidden);
        assert.equal(
            (await AccountModel.findById(account._id).lean()).mfaEnabled,
            true,
            'Finishing must not disable MFA'
        );
        await open();
        await page.waitForSelector('[data-mfa-manage]:not([hidden])');
        assert.equal(await page.$eval('[data-mfa-recovery]', (el) => el.value), '');
        await click('[data-mfa-manage]');
        await page.$eval('[data-mfa-disable]', (el) => el.scrollIntoView({ block: 'center' }));
        await click('[data-mfa-disable]');
        await page.waitForFunction(() =>
            document.querySelector('[data-mfa-state]').classList.contains('warn')
        );
        assert.equal((await AccountModel.findById(account._id).lean()).mfaEnabled, false);
        assert.deepEqual(errors, []);
        console.log(
            JSON.stringify({
                passed: true,
                realBackend: true,
                isolatedAccount: true,
                portal: companyMode ? 'company' : 'agent',
                qr: true,
                appLink: true,
                manualKey: true,
                resumeSetup: true,
                rejectWrongCode: true,
                confirmTotp: true,
                recoveryCopyAndDownload: true,
                resumeRecovery: true,
                finishAndDisable: true,
                themes: ['day', 'night'],
                widths: [320, 390, 430],
            })
        );
    } finally {
        if (browser) await browser.close();
        if (account) {
            await TrustedDevice.deleteMany({ accountId: account._id });
            await AccountModel.deleteOne({ _id: account._id, webUsername: username });
        }
        if (company) await Company.deleteOne({ _id: company._id });
        await mongoose.disconnect();
    }
}
main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
