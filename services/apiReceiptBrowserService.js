'use strict';
const { loadPuppeteer } = require('../utils/puppeteerLoader');

const closeReceiptBrowser = async (browser) => {
    if (!browser) return;
    let timer;
    let closed = false;
    try {
        await Promise.race([
            Promise.resolve()
                .then(() => browser.close())
                .then(() => {
                    closed = true;
                })
                .catch(() => {}),
            new Promise((resolve) => {
                timer = setTimeout(resolve, 3000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        if (!closed) {
            try {
                browser.process()?.kill();
            } catch (_) {}
            try {
                browser.disconnect();
            } catch (_) {}
        }
    }
};

// Rendering is optional: it must not retain the provider's financial execution slot.
const renderApiReceiptWithBrowser = async (render, { timeoutMs = 25000 } = {}) => {
    let browser,
        timer,
        expired = false;
    const task = async () => {
        const puppeteer = await loadPuppeteer();
        if (expired) return null;
        browser = await puppeteer.launch({
            headless: 'new',
            timeout: 10000,
            protocolTimeout: 15000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
            ],
        });
        if (expired) {
            await closeReceiptBrowser(browser);
            return null;
        }
        return render(browser);
    };
    try {
        return await Promise.race([
            task(),
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    expired = true;
                    resolve(null);
                }, timeoutMs);
            }),
        ]);
    } catch (_) {
        return null;
    } finally {
        expired = true;
        clearTimeout(timer);
        await closeReceiptBrowser(browser);
    }
};

module.exports = { renderApiReceiptWithBrowser };
