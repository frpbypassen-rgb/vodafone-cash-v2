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
        expect(html.match(/aria-label="أقسام الإعدادات"/g) || []).toHaveLength(1);
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
        '/client/account?tab=summary',
        '/client/account?tab=export',
        '/security/sessions',
        '/client/settings?section=documents',
        '/client/support',
    ])
        expect(html).toContain(url);
    const sub = await render('client/partials/retail_directory.ejs', { canRequestDeposit: false });
    expect(sub).not.toContain('deposits-new');
    expect(sub).not.toContain('integrations');
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

test('customer More reuses company popover presentation and preserves account pages', async () => {
    const html = await render('client/hub/account.ejs', { activeTab: 'operations' });
    expect(html).toContain('company-mobile/mobile-menu.css');
    expect(html).toContain('popover="auto"');
    expect(html).toContain('popovertarget="retailMoreDialog"');
    expect(html).toContain('agent-more-grid');
    const moreMenu = html.split('id="retailMoreDialog"')[1].split('</nav>')[0];
    ['/client/dashboard', '/client/transfers', '/client/smart-transfer', '/client/internal-transfer'].forEach(href => {
        expect(moreMenu).not.toContain('href="' + href + '"');
    });
    expect(moreMenu).toContain('/client/account?tab=operations');
    expect(html).not.toContain('href="/client/reports"');
    expect(html).toContain('agent-more-footer');
    expect(html).not.toContain('retailMoreSearch');
    expect(html).not.toContain('<dialog');
    expect(html).toContain('/client/settings?section=security');
    expect(html).not.toContain('/client/integrations');
});
