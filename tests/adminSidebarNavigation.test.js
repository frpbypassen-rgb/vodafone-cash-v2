'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const SIDEBAR_PATH = path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs');

const REQUIRED_ADMIN_HREFS = [
    '/',
    '/system-monitor',
    '/financial-movements',
    '/transactions/pulse',
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

const CLIENT_ONLY_HREFS = [
    '/client',
    '/client/dashboard',
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

    test('keeps system monitor and central ledger near the top of monitoring', () => {
        const menuStart = source.indexOf('class="sidebar-menu');
        const monitoringBlock = source.slice(menuStart, source.indexOf('إدارة الحسابات'));
        expect(monitoringBlock.indexOf('/system-monitor')).toBeGreaterThan(-1);
        expect(monitoringBlock.indexOf('/financial-movements')).toBeGreaterThan(-1);
        expect(monitoringBlock.indexOf('/system-monitor')).toBeLessThan(monitoringBlock.indexOf('/financial-movements'));
        expect(monitoringBlock).toMatch(/مراقبة النظام/);
        expect(monitoringBlock).toMatch(/السجل المركزي \(الحركات المالية\)/);
        expect(monitoringBlock).toMatch(/السجل المركزي/);
    });

    test('lists every admin page that exists as a staff route', () => {
        const html = renderSidebar({ activePage: 'dashboard', role: 'admin' });
        const hrefs = new Set(extractHrefs(html));
        REQUIRED_ADMIN_HREFS.forEach((href) => {
            expect(hrefs.has(href)).toBe(true);
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
});
