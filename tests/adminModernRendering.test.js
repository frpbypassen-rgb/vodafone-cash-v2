'use strict';

const path = require('path');
const ejs = require('ejs');

const render = (file, locals = {}) => ejs.renderFile(path.join(__dirname, '../views', file), {
    csrfToken: 'fixture-csrf', adminName: 'مدير الاختبار', role: 'master', ...locals
});

describe('admin modern presentation boundaries', () => {
    test('admin sign-in theme is opt-in and preserves the unified authentication fields', async () => {
        const locals = {
            error: null, tenant: null, clientPortal: false,
            passwordResetEmailEnabled: false, passwordResetSupportPhone: '', passwordResetSupportEmail: ''
        };
        const ordinary = await render('unified_login.ejs', locals);
        const admin = await render('unified_login.ejs', { ...locals, adminPortal: true });
        expect(ordinary).not.toContain('/css/admin-modern.css');
        expect(admin).toContain('/css/admin-modern.css');
        for (const field of ['username', 'password', '_csrf', 'latitude', 'longitude']) {
            expect(admin).toContain(`name="${field}"`);
            expect(ordinary).toContain(`name="${field}"`);
        }
        expect(admin).toContain('action="/login" method="POST"');
        expect(admin).toContain('name="portal" value="admin"');
        expect(admin).toContain('value="fixture-csrf"');
    });

    test('executor web accounts render the real group relation and escape its label', async () => {
        const employee = {
            _id: 'fixture-employee', name: 'منفذ تجريبي',
            groupId: { name: '<مجموعة التنفيذ>' }, webUsername: 'fixture.operator', webPassword: ''
        };
        const html = await render('settings_executors_web.ejs', {
            employees: [employee], webExecutors: [employee], query: {}
        });
        expect(html).toContain('&lt;مجموعة التنفيذ&gt;');
        expect(html).not.toContain('<مجموعة التنفيذ>');
        expect(html).toContain('action="/settings/executors-web/edit"');
        expect(html).toContain('action="/settings/executors-web/delete"');
        expect(html).toContain('name="employeeId" value="fixture-employee"');
    });

    test('print theme is self-contained for offline PDF rendering', async () => {
        const html = await render('partials/admin_modern_print.ejs');
        expect(html).not.toMatch(/<script|<link|https?:\/\//);
        expect(html).toContain('@media print');
    });
});
