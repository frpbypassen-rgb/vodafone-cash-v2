'use strict';
const ejs = require('ejs'),
    path = require('path');
const data = {
    retailModern: true,
    clientTheme: 'day',
    csrfToken: 'test',
    accountType: 'user',
    account: { _id: 'customer', name: 'عميل تجريبي', role: 'user' },
    user: { name: 'عميل تجريبي', role: 'user', accountCode: '10482' },
    profile: {
        accountTypeName: 'عميل مباشر',
        canEditProfile: true,
        name: 'عميل تجريبي',
        address: 'طرابلس',
        phone: '0911',
        username: 'demo',
        accountCode: '10482',
        userRoleLabel: 'عميل',
        accountStatus: 'active',
        systemStatus: 'تعمل',
    },
    canRequestDeposit: true,
    settingsSuccess: '',
    settingsError: '',
    isSystemOpen: true,
};
const render = (view, extra = {}) =>
    ejs.renderFile(path.join(__dirname, '../views', view), { ...data, ...extra });
test.each([
    'operations',
    'summary',
    'export',
    'deposits-new',
    'deposits-pending',
    'deposits-accepted',
    'deposits-rejected',
])('account tab %s uses one shared customer shell', async (activeTab) => {
    const html = await render('client/hub/account.ejs', { activeTab });
    expect(html).toContain('retail-pages.css');
    expect(html.match(/class="bottomnav"/g) || []).toHaveLength(1);
    expect(html).not.toContain('client-os-shell');
    expect(html).not.toContain('data-company-shell');
});
test.each(['profile', 'security', 'notifications', 'appearance', 'documents'])(
    'settings %s is rendered once for both screen sizes',
    async (activeSection) => {
        const html = await render('client/hub/settings.ejs', { activeSection });
        expect(html).toContain('retail-pages.css');
        expect(html).toContain('href="/client/logout"');
        expect(html.match(/aria-label="أقسام الإعدادات"/g) || []).toHaveLength(0);
        expect(html).toContain('retail-settings-back');
        expect(html).not.toContain('client-os-shell');
        if (activeSection === 'security') expect(html.match(/name="currentPassword"/g) || []).toHaveLength(1);
    }
);
test.each(['client/hub/reports.ejs', 'client/support.ejs'])(
    '%s uses the same shell as home',
    async (view) => {
        const html = await render(view);
        expect(html).toContain('retail-pages.css');
        expect(html).toContain('data-customer-bell');
        expect(html.match(/class="bottomnav"/g) || []).toHaveLength(1);
    }
);
test('home directory lists all available pages but omits central funding for sub-clients', async () => {
    const html = await render('client/partials/retail_directory.ejs');
    for (const url of [
        '/client/account?tab=operations',
        '/client/settings?section=documents',
        '/client/support',
    ])
        expect(html).toContain(url);
    const sub = await render('client/partials/retail_directory.ejs', { canRequestDeposit: false });
    expect(sub).not.toContain('deposits-new');
    expect(sub).not.toContain('integrations');
    expect(html).not.toContain('/security/sessions');
    expect(html).not.toContain('tab=deposits');
});
test('retail devices page keeps security controls in the shared shell', async () => {
    const html = await render('account_security_sessions.ejs', {
        principalName: 'عميل',
        isAgentSessions: false,
        returnUrl: '/client/settings?section=security',
    });
    expect(html).toContain('retail-pages.css');
    expect(html).toContain('/security/sessions/data');
    expect(html).toContain('data-devices');
    expect(html.match(/class="bottomnav"/g) || []).toHaveLength(1);
});

test('customer navigation keeps five direct pages without a More menu', async () => {
    const html = await render('client/hub/account.ejs', { activeTab: 'operations' });
    expect(html).not.toContain('retailMore');
    expect(html).not.toContain('retail-more.js');
    expect(html).not.toContain('company-mobile/mobile-menu.css');
    const dock = html.split('class="bottomnav"')[1].split('</nav>')[0];
    expect(dock.match(/<a /g)).toHaveLength(5);
    expect(dock.lastIndexOf('href="/client/settings"')).toBeGreaterThan(
        dock.lastIndexOf('href="/client/support"')
    );
    expect(dock).toContain('href="/client/settings"');
    expect(dock).toContain('href="/client/account?tab=operations"');
});

test.each(['day', 'night'])('settings overview presents six sections in %s theme', async (clientTheme) => {
    const html = await render('client/hub/settings.ejs', { activeSection: 'overview', clientTheme });
    expect(html.match(/class="retail-settings-card"/g)).toHaveLength(6);
    expect(html).toContain('href="/security/sessions"');
    expect(html).toContain('retailLogoutDialog');
    expect(html).not.toContain('name="currentPassword"');
    expect(html).not.toContain('name="name"');
    expect(html).toContain('data-theme="' + clientTheme + '"');
});

test('profile separates editable fields from read-only account information', async () => {
    const html = await render('client/hub/settings.ejs', { activeSection: 'profile' });
    expect(html).toContain('id="retailProfileForm"');
    expect(html).toContain('action="/client/profile?return=settings"');
    expect(html.match(/name="name"/g)).toHaveLength(1);
    expect(html.match(/name="address"/g)).toHaveLength(1);
    expect(html).not.toContain('name="phone"');
    expect(html).toContain('retail-profile-info');
});
test('read-only profile cannot render an edit form', async () => {
    const html = await render('client/hub/settings.ejs', {
        activeSection: 'profile',
        profile: { ...data.profile, canEditProfile: false },
    });
    expect(html).not.toContain('id="retailProfileForm"');
    expect(html).toContain('بيانات هذا الحساب للعرض فقط.');
});
