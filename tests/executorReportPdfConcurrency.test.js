'use strict';

jest.mock('../utils/puppeteerLoader', () => ({ loadPuppeteer: jest.fn() }));

const fs = require('fs');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const { closeReportPdfBrowser, generateExecutorReportPdf } = require('../services/reportPdfService');

describe('executor PDF concurrency', () => {
    afterEach(async () => {
        await closeReportPdfBrowser();
        jest.restoreAllMocks();
    });

    test('rejects a third concurrent render and frees capacity afterward', async () => {
        jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate === 'chrome');
        let releasePages;
        const pagesReady = new Promise((resolve) => { releasePages = resolve; });
        const page = () => ({
            setContent: jest.fn(() => pagesReady),
            emulateMediaType: jest.fn().mockResolvedValue(),
            pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-test')),
            close: jest.fn().mockResolvedValue()
        });
        const browser = {
            newPage: jest.fn(async () => page()),
            on: jest.fn(),
            close: jest.fn().mockResolvedValue()
        };
        loadPuppeteer.mockResolvedValue({ executablePath: () => 'chrome', launch: jest.fn().mockResolvedValue(browser) });
        const app = { render: (_view, _data, callback) => callback(null, '<html></html>') };

        const first = generateExecutorReportPdf(app, { report: {} });
        const second = generateExecutorReportPdf(app, { report: {} });
        await expect(generateExecutorReportPdf(app, { report: {} })).rejects.toMatchObject({ code: 'PDF_BUSY' });
        releasePages();
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        await expect(generateExecutorReportPdf(app, { report: {} })).resolves.toBeInstanceOf(Buffer);
    });
});
