'use strict';
const { renderWorkspacePage } = require('./helpers/agentPortalFixtures');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('company gallery loads the shared stylesheet directly without compatibility import waterfalls', async () => {
    const html = await renderWorkspacePage('services');
    expect(html).toContain('/css/portal-shell/base.css');
    expect(html).not.toContain('href="/css/client-workspace.css');
});
test('company gallery does not load page-specific accounting and staff styles', async () => {
    const html = await renderWorkspacePage('services');
    for (const file of [
        'finance',
        'reports',
        'staff',
        'customers',
        'report-email',
        'telegram-settings',
        'home',
        'support',
        'transactions',
    ])
        expect(html).not.toContain(`/css/company-mobile/${file}.css`);
    expect(html).toContain('/css/company-mobile/services.css');
});
test('company home does not block document readiness on remote Chart.js', async () => {
    const html = await renderWorkspacePage('overview');
    expect(html).not.toMatch(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js/);
    expect(html).toContain('/js/company-mobile/chart-loader.js');
});
test('company navigation uses the existing small brand image without missing-image redirects', async () => {
    const html = await renderWorkspacePage('overview');
    expect(html).toContain('/images/login-otp-logo.jpg');
    expect(html).not.toContain('/images/logo.jpeg');
    expect(html).not.toContain('/images/logo.jpg');
});
test('chart loader skips phones and loads once when desktop analytics become available', () => {
    const scripts = [];
    const media = { matches: false, addEventListener: jest.fn() };
    const window = { matchMedia: () => media, dispatchEvent: jest.fn() };
    const document = {
        getElementById: () => ({}),
        createElement: () => ({}),
        head: { append: (script) => scripts.push(script) },
    };
    const source = fs.readFileSync(
        path.join(__dirname, '../public/js/company-mobile/chart-loader.js'),
        'utf8'
    );
    vm.runInNewContext(source, {
        window,
        document,
        Event: class {
            constructor(type) {
                this.type = type;
            }
        },
    });
    expect(scripts).toHaveLength(0);
    media.matches = true;
    media.addEventListener.mock.calls[0][1]();
    media.addEventListener.mock.calls[0][1]();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].async).toBe(true);
    scripts[0].onload();
    expect(window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'company-chart-ready' })
    );
});
test('desktop chart initializes once even when the canvas is exposed as a window named property', () => {
    const header = fs.readFileSync(path.join(__dirname, '../public/js/portal-workspace/header.js'), 'utf8');
    const source = header.slice(
        header.indexOf('const setupCommandChart ='),
        header.indexOf('\n    setupTheme();')
    );
    const canvas = {};
    const Chart = jest.fn(function (element) {
        this.canvas = element;
    });
    const window = { Chart, commandCenterWeekChart: canvas };
    vm.runInNewContext(source + ';setupCommandChart();setupCommandChart();', {
        window,
        config: { commandCenterChart: { labels: ['day'], counts: [1], values: [10] } },
        document: { getElementById: () => canvas, documentElement: {} },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
    });
    expect(Chart).toHaveBeenCalledTimes(1);
});
