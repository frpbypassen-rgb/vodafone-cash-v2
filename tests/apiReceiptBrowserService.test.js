'use strict';
jest.mock('../utils/puppeteerLoader', () => ({ loadPuppeteer: jest.fn() }));
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const { renderApiReceiptWithBrowser } = require('../services/apiReceiptBrowserService');
beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

test('successful rendering returns the image and closes its own browser', async () => {
    const browser = { close: jest.fn().mockResolvedValue(undefined) };
    loadPuppeteer.mockResolvedValue({ launch: async () => browser });
    await expect(renderApiReceiptWithBrowser(async () => Buffer.from('image'))).resolves.toEqual(
        Buffer.from('image')
    );
    expect(browser.close).toHaveBeenCalledTimes(1);
});

test('hung rendering and hung browser close cannot retain a financial worker indefinitely', async () => {
    const kill = jest.fn();
    const browser = {
        close: jest.fn(() => new Promise(() => {})),
        process: () => ({ kill }),
        disconnect: jest.fn(),
    };
    loadPuppeteer.mockResolvedValue({ launch: async () => browser });
    const pending = renderApiReceiptWithBrowser(() => new Promise(() => {}), { timeoutMs: 1000 });
    await jest.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toBeNull();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
});

test('a browser that launches after expiry is cleaned up without rendering', async () => {
    let release;
    const browser = { close: jest.fn().mockResolvedValue(undefined) };
    loadPuppeteer.mockResolvedValue({
        launch: () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    });
    const render = jest.fn();
    const pending = renderApiReceiptWithBrowser(render, { timeoutMs: 1000 });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeNull();
    release(browser);
    await jest.advanceTimersByTimeAsync(0);
    expect(render).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
});

test('browser launch failures allow the existing canvas fallback', async () => {
    loadPuppeteer.mockResolvedValue({
        launch: async () => {
            throw new Error('NO_BROWSER');
        },
    });
    await expect(renderApiReceiptWithBrowser(jest.fn())).resolves.toBeNull();
});
