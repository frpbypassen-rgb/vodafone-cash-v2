'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { sanitizeAccountStatementReport } = require('../utils/accountStatementPrivacy');

let sharedBrowserPromise = null;

const executableCandidates = () => {
    const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH];
    if (process.platform === 'win32') {
        candidates.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        );
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        );
    } else {
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium'
        );
    }

    try {
        candidates.unshift(puppeteer.executablePath());
    } catch (_) {}
    return candidates.filter(Boolean);
};

const findBrowserExecutable = () => executableCandidates().find((candidate) => fs.existsSync(candidate));

const renderView = (app, view, data) => new Promise((resolve, reject) => {
    app.render(view, data, (error, html) => {
        if (error) reject(error);
        else resolve(html);
    });
});

const logoDataUri = () => {
    const candidates = [
        path.join(process.cwd(), 'public', 'images', 'logo.jpeg'),
        path.join(process.cwd(), 'public', 'images', 'logo.jpg'),
        path.join(process.cwd(), 'public', 'images', 'logo.png')
    ];
    const logoPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!logoPath) return '';
    const extension = path.extname(logoPath).toLowerCase();
    const mime = extension === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(logoPath).toString('base64')}`;
};

const getSharedBrowser = (executablePath) => {
    if (!sharedBrowserPromise) {
        sharedBrowserPromise = puppeteer.launch({
            headless: true,
            executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            protocolTimeout: 60000
        }).then((browser) => {
            browser.on('disconnected', () => {
                sharedBrowserPromise = null;
            });
            return browser;
        }).catch((error) => {
            sharedBrowserPromise = null;
            throw error;
        });
    }
    return sharedBrowserPromise;
};

const closeReportPdfBrowser = async () => {
    const browserPromise = sharedBrowserPromise;
    sharedBrowserPromise = null;
    if (!browserPromise) return;
    const browser = await browserPromise.catch(() => null);
    if (browser) await browser.close().catch(() => {});
};

const preparePdfReport = (report = {}) => {
    const sanitized = sanitizeAccountStatementReport(report);
    return {
        ...sanitized,
        closedDayChanges: [],
        closure: {
            ...(sanitized.closure || {}),
            hasPostCloseChanges: false
        }
    };
};

const generateAdminReportPdf = async (app, data) => {
    const executablePath = findBrowserExecutable();
    if (!executablePath) {
        const error = new Error('PDF_BROWSER_NOT_FOUND');
        error.code = 'PDF_BROWSER_NOT_FOUND';
        throw error;
    }

    const html = await renderView(app, 'reports_pdf', {
        ...data,
        report: preparePdfReport(data.report),
        logoDataUri: logoDataUri()
    });
    let page;
    try {
        const browser = await getSharedBrowser(executablePath);
        page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        await page.emulateMediaType('print');
        const pdf = await page.pdf({
            format: 'A4',
            landscape: true,
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '11mm', right: '9mm', bottom: '15mm', left: '9mm' },
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `
                <div style="width:100%;padding:0 10mm;font-family:Arial,sans-serif;font-size:8px;color:#59636e;display:flex;justify-content:space-between;direction:rtl;">
                    <span>Power Pay AL-Ahram - تقرير مالي معتمد إلكترونياً</span>
                    <span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span>
                </div>
            `
        });
        return Buffer.from(pdf);
    } finally {
        if (page) await page.close().catch(() => {});
    }
};

const generateExecutorReportPdf = async (app, data) => {
    const executablePath = findBrowserExecutable();
    if (!executablePath) {
        const error = new Error('PDF_BROWSER_NOT_FOUND');
        error.code = 'PDF_BROWSER_NOT_FOUND';
        throw error;
    }

    const html = await renderView(app, 'executor_report_pdf', {
        ...data,
        logoDataUri: logoDataUri()
    });
    let page;
    try {
        const browser = await getSharedBrowser(executablePath);
        page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        await page.emulateMediaType('print');
        const pdf = await page.pdf({
            format: 'A4',
            landscape: true,
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '11mm', right: '9mm', bottom: '13mm', left: '9mm' },
            displayHeaderFooter: false
        });
        return Buffer.from(pdf);
    } finally {
        if (page) await page.close().catch(() => {});
    }
};

module.exports = {
    closeReportPdfBrowser,
    findBrowserExecutable,
    generateAdminReportPdf,
    generateExecutorReportPdf,
    getSharedBrowser,
    logoDataUri,
    preparePdfReport,
    renderView
};
