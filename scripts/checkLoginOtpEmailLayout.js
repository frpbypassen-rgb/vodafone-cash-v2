'use strict';

/* global document */

const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '../public/images/login-otp-logo.jpg');

const measure = () => {
    const card = document.querySelector('table[width="620"]');
    const phone = document.querySelector('a[href^="tel:"] bdo');
    const range = document.createRange();
    range.setStart(phone.firstChild, 0);
    range.setEnd(phone.firstChild, 1);
    const plus = range.getBoundingClientRect().x;
    range.setStart(phone.firstChild, 1);
    range.setEnd(phone.firstChild, 5);
    const digits = range.getBoundingClientRect().x;
    return {
        cardWidth: card.getBoundingClientRect().width,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        phone: phone.textContent,
        plus,
        digits,
        images: [...document.images].map((img) => ({
            src: img.getAttribute('src'),
            complete: img.complete,
            naturalWidth: img.naturalWidth
        })),
        links: [...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))
    };
};

const main = async () => {
    const puppeteer = (await import('puppeteer')).default;
    const { buildLoginOtpHtmlV2 } = require('../services/emailOtpMailer');
    const jpeg = fs.readFileSync(LOGO_PATH);
    const dataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    const base = {
        otp: '482913',
        expiresMinutes: 5,
        year: 2026,
        attemptAt: new Date('2026-09-22T12:22:00.000Z'),
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        loginAccount: 'tizari@ahram.com'
    };
    const documents = {
        short: buildLoginOtpHtmlV2({ ...base, accountName: 'م' }).replaceAll('https://ahrampay.com/images/login-otp-logo.jpg', dataUri),
        long: buildLoginOtpHtmlV2({
            ...base,
            accountName: `عبدالرحمن ${'بن '.repeat(8)}التجريبي`
        }).replaceAll('https://ahrampay.com/images/login-otp-logo.jpg', dataUri)
    };
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const widths = {};
    try {
        const page = await browser.newPage();
        for (const width of [320, 600]) {
            await page.setViewport({ width, height: 1400, deviceScaleFactor: 1 });
            const variants = {};
            for (const [name, html] of Object.entries(documents)) {
                await page.setContent(html, { waitUntil: 'load' });
                variants[name] = await page.evaluate(measure);
            }
            widths[width] = variants.short;
            widths[width].longScrollWidth = variants.long.scrollWidth;
            widths[width].longClientWidth = variants.long.clientWidth;
        }
    } finally {
        await browser.close();
    }
    process.stdout.write(JSON.stringify({ ok: true, widths }));
};

main().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exitCode = 1;
});
