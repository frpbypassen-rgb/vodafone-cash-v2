'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const SIDEBAR_PATH = path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs');

const REQUIRED_ADMIN_HREFS = [
    '/',
    '/financial-movements',
    '/transactions/live',
    '/transactions',
    '/transactions/operations',
    '/transactions/movements',
    '/transactions/search',
    '/reports',
    '/whatsapp-monitor',
    '/admin/webhooks',
    '/audit-log',
    '/clients',
    '/executors',
    '/employees',
    '/registration-requests',
    '/support',
    '/support?category=deposit',
    '/complaints',
    '/broadcast',
    '/settings',
    '/settings/clients-web',
    '/settings/executors-web',
    '/admin/security',
    '/security/sessions'
];

const REMOVED_ADMIN_HREFS = [
    '/system-monitor',
    '/transactions/pulse'
];

const CLIENT_ONLY_HREFS = [
    '/client',
    '/client/dashboard',
    '/client/services',
    '/executor-portal',
    '/corporate'
];

const extractHrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

const renderSidebar = (locals) => ejs.render(fs.readFileSync(SIDEBAR_PATH, 'utf8'), {
    csrfToken: 'test-csrf',
    adminName: 'مدير الاختبار',
    ...locals
}, { filename: SIDEBAR_PATH });

describe('admin sidebar navigation', () => {
    const source = fs.readFileSync(SIDEBAR_PATH, 'utf8');

    test('does not hide admin pages on mobile', () => {
        expect(source).not.toMatch(/sidebar-menu-hide-mobile/);
    });

    test('does not expose removed monitor and pulse admin pages', () => {
        expect(source).not.toMatch(/\/system-monitor/);
        expect(source).not.toMatch(/\/transactions\/pulse/);
        expect(source).not.toMatch(/مراقبة النظام/);
        expect(source).not.toMatch(/سجل العمليات المباشرة/);
        expect(source).not.toMatch(/transactions_pulse/);
    });

    test('keeps central ledger near the top of monitoring', () => {
        const menuStart = source.indexOf('class="sidebar-menu');
        const monitoringBlock = source.slice(menuStart, source.indexOf('إدارة الحسابات'));
        expect(monitoringBlock.indexOf('/financial-movements')).toBeGreaterThan(-1);
        expect(monitoringBlock.indexOf('/financial-movements')).toBeLessThan(monitoringBlock.indexOf('/transactions/live'));
        expect(monitoringBlock).toMatch(/السجل المركزي \(الحركات المالية\)/);
        expect(monitoringBlock).toMatch(/المراقبة الحية/);
        expect(monitoringBlock).toMatch(/التقارير الشاملة/);
    });

    test('lists every admin page that exists as a staff route', () => {
        const html = renderSidebar({ activePage: 'dashboard', role: 'admin' });
        const hrefs = new Set(extractHrefs(html));
        REQUIRED_ADMIN_HREFS.forEach((href) => {
            expect(hrefs.has(href)).toBe(true);
        });
        REMOVED_ADMIN_HREFS.forEach((href) => {
            expect(hrefs.has(href)).toBe(false);
        });
        CLIENT_ONLY_HREFS.forEach((href) => {
            expect(hrefs.has(href)).toBe(false);
        });
        expect(html).not.toContain('/settings/users');
    });

    test('shows admin-user management only for master role', () => {
        const html = renderSidebar({ activePage: 'settings_users', role: 'master' });
        expect(extractHrefs(html)).toContain('/settings/users');
        expect(html).toMatch(/مديري لوحة التحكم/);
    });

    test('removed monitor dashboard and pulse view files', () => {
        expect(fs.existsSync(path.join(__dirname, '..', 'public', 'system-monitor.html'))).toBe(false);
        expect(fs.existsSync(path.join(__dirname, '..', 'views', 'transaction_pulse.ejs'))).toBe(false);
    });
});
