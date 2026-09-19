'use strict';

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const {
    SERVICE_CATALOG,
    STATUS_META,
    PAGE_META,
    buildNavigation,
    buildCompanyMobileNav,
    resolvePortalHomeHref
} = require('../services/businessPortalService');

const COMPANY_TITLES = {
    services: { title: 'معرض الخدمات', eyebrow: 'قناة واحدة لكل بطاقة' },
    smart_transfer: { title: 'التحويل الذكي', eyebrow: 'من رسالة إلى عملية' },
    transactions: { title: 'غرفة العمليات', eyebrow: 'بحث ومتابعة التنفيذ' },
    settings: { title: 'بيانات المنشأة', eyebrow: 'الملف والتواصل' },
    security: { title: 'أمان الحساب', eyebrow: 'كلمة المرور وMFA والأجهزة' },
    support: { title: 'مركز الدعم', eyebrow: 'مساعدة ومتابعة آمنة' },
    finance: { title: 'مكتب المحاسبة', eyebrow: 'رصيد وكشوف بلا تنفيذ' }
};

const WORKSPACE_VIEW = path.join(__dirname, '..', 'views', 'client', 'workspace.ejs');

const managerWorkspace = {
    type: 'company',
    isCompany: true,
    isAgent: false,
    persona: 'manager',
    roleLabel: 'مدير الشركة',
    entityLabel: 'الشركة',
    portalLabel: 'بوابة الشركات',
    forceToday: false,
    actor: { name: 'مدير الاختبار', webUsername: 'manager@ahram.com' },
    entity: {
        name: 'شركة الاختبار',
        accountCode: 'C-1001',
        balance: 1250.5,
        creditLimit: 5000,
        phone: '0910000000',
        businessProfile: { contactName: 'مدير الاختبار', city: 'طرابلس' }
    },
    permissions: {
        owner: true,
        manager: true,
        accountant: false,
        employee: false,
        canTransfer: true,
        canInternalTransfer: true,
        canViewBalance: true,
        canViewReports: true,
        canRequestDeposit: true,
        canEditSettings: true,
        canManageCustomers: false
    }
};

const serviceCatalog = SERVICE_CATALOG.map((service) => ({ ...service, rate: 4.85 }));

const renderWorkspacePage = (page, extra = {}) => {
    const workspace = extra.workspace || managerWorkspace;
    const navigation = extra.navigation || buildNavigation(workspace, page);
    return ejs.renderFile(WORKSPACE_VIEW, {
        page,
        pageMeta: { ...PAGE_META[page], ...(COMPANY_TITLES[page] || {}) },
        workspace,
        portalHomeHref: resolvePortalHomeHref(workspace),
        navigation,
        companyMobileNav: buildCompanyMobileNav(workspace, navigation),
        statusMeta: STATUS_META,
        serviceCatalog,
        serviceRates: { vodafone: 4.85 },
        ratesUpdatedAt: new Date(),
        pendingRateUpdate: null,
        lowBalanceAlert: null,
        systemOpen: true,
        query: {},
        csrfToken: 'test-csrf',
        now: new Date(),
        companyTheme: extra.companyTheme || 'day',
        todaySummary: { totalCount: 0 },
        recentTransactions: [],
        filters: { search: '', status: '', service: '', from: '', to: '', type: '', label: 'اليوم', history: '' },
        summary: { totalCount: 0, completedCount: 0, pendingCount: 0, cancelledCount: 0, totalEGP: 0 },
        transactions: [],
        total: 0,
        pagination: { page: 1, pages: 1 },
        settingsData: { profile: managerWorkspace.entity.businessProfile },
        financeSummary: { credits: 0, debits: 0, net: 0, count: 0 },
        movements: [],
        listTruncated: false,
        shownMovementCount: 0,
        staff: [],
        ...extra,
        workspace,
        navigation,
        companyMobileNav: extra.companyMobileNav || buildCompanyMobileNav(workspace, navigation)
    }, { filename: WORKSPACE_VIEW });
};

const CANONICAL_ROUTES = [
    '/client/services',
    '/client/smart-transfer',
    '/client/transactions',
    '/client/settings',
    '/client/security',
    '/client/support',
    '/client/finance'
];

describe('canonical company portal pages', () => {
    test('client portal still registers the services gallery and linked pages', () => {
        const clientPortal = require('../routes/clientPortal');
        const registered = [];
        const posted = [];
        const walk = (stack) => {
            stack.forEach((layer) => {
                if (layer.route?.path && layer.route.methods.get) {
                    registered.push(layer.route.path);
                }
                if (layer.route?.path && layer.route.methods.post) {
                    posted.push(layer.route.path);
                }
            });
        };
        walk(clientPortal.stack);
        expect(registered).toEqual(expect.arrayContaining([
            '/services',
            '/smart-transfer',
            '/transactions',
            '/settings',
            '/security',
            '/support',
            '/finance',
            '/company/deposits',
            '/api/notifications',
            '/api/web-push/status',
            '/sw.js'
        ]));
        expect(posted).toEqual(expect.arrayContaining([
            '/api/web-push/subscribe',
            '/api/web-push/unsubscribe',
            '/api/web-push/test',
            '/api/notifications/read-all',
            '/api/theme',
            '/settings/theme'
        ]));
        expect(registered).not.toContain('/company-next-page');
    });

    test.each([
        ['services', ['اختر · راجع · أرسل', 'معرض الخدمات', 'محافظ كاش', '/client/smart-transfer', '/client/transactions']],
        ['smart_transfer', ['التحويل الذكي', 'معرض الخدمات', '/client/services']],
        ['transactions', ['غرفة العمليات', 'معرض الخدمات', '/client/support']],
        ['settings', ['بيانات المنشأة', 'أمان الحساب', '/client/security']],
        ['security', ['أمان الحساب', 'بيانات المنشأة', '/client/settings']],
        ['support', ['مركز الدعم', 'غرفة العمليات', '/client/transactions']],
        ['finance', ['مكتب المحاسبة', 'كشف الحساب', '/client/reports']]
    ])('renders company %s without competing portal links', async (page, mustInclude) => {
        const html = await renderWorkspacePage(page, page === 'services' ? {
            pageMeta: { title: 'اختر · راجع · أرسل', eyebrow: 'يوم التنفيذ', icon: 'fa-cubes' },
            workspace: { ...managerWorkspace, forceToday: true, persona: 'employee', roleLabel: 'موظف', portalLabel: 'غرفة التنفيذ', permissions: { ...managerWorkspace.permissions, manager: false, employee: true, canViewBalance: false, canViewReports: false, canInternalTransfer: false, canRequestDeposit: false } }
        } : {});

        mustInclude.forEach((snippet) => expect(html).toContain(snippet));
        expect(html).not.toContain('الواجهة الجديدة');
        expect(html).not.toContain('href="/corporate"');
        expect(html).not.toContain('/client/company-next');
        expect(html).toContain('href="/client/services"');
        CANONICAL_ROUTES.forEach((href) => {
            if (html.includes(href) || href === '/client/finance' && page !== 'finance') return;
        });
    });

    test('shares one themed shell with switcher, bell, sidebar, and mobile dock', async () => {
        const html = await renderWorkspacePage('services');
        expect(html).toContain('data-company-shell');
        expect(html).toContain('cp-app');
        expect(html).toContain('cp-sidebar');
        expect(html).toContain('cp-page-hero');
        expect(html).toContain('cp-service-grid');
        expect(html).toContain('cp-service-card');
        expect(html).toContain('cp-theme-rail');
        expect(html).toContain('/css/company-portal.tokens.css');
        expect(html).toContain('/css/company-portal-layout.css');
        expect(html).toContain('/css/company-portal-theme-day.css');
        expect(html).toContain('/css/company-portal-theme-night.css');
        expect(html).toContain('/css/company-portal-theme-pharaonic.css');
        expect(html).toContain('20260919-visual3');
        expect(html).not.toContain('client-company-os.css');
        expect(html).not.toContain('cos-ledger-office');
        expect(html).not.toContain('class="cos-tile');
        expect(html).toContain('data-company-role=');
        expect(html).toContain('IBM+Plex+Sans+Arabic');
        expect(html).toContain('data-company-bell');
        expect(html).toContain('id="businessSidebar"');
        expect(html).toContain('data-company-dock');
        expect(html).toContain('data-company-theme-switcher');
        expect(html).toContain('data-theme-option="day"');
        expect(html).toContain('data-theme-option="night"');
        expect(html).toContain('data-theme-option="pharaonic"');
        expect(html).toContain('ahram_company_theme');
        expect(html).toContain('data-theme="day"');
        expect(html).toContain('#cp-icon-temple');
        expect(html).toContain('شركة الاختبار');
        expect(html).toContain('الرصيد');
    });

    test('team page uses the new work cards instead of company-os chrome', async () => {
        const html = await renderWorkspacePage('staff', {
            staffSummary: { total: 3, active: 2, managers: 1, accountants: 1, monthOperations: 12 },
            staffFilters: { search: '', role: '', status: '' },
            staff: []
        });
        expect(html).toContain('cp-page-hero');
        expect(html).toContain('فريق الشركة');
        expect(html).toContain('cp-work-list');
        expect(html).not.toContain('cos-ledger-office');
        expect(html).not.toContain('cos-ops-card');
    });

    test('filters mobile dock items by company role', async () => {
        const managerHtml = await renderWorkspacePage('services');
        expect(managerHtml).toContain('data-dock-key="services"');
        expect(managerHtml).toContain('data-dock-key="smart_transfer"');
        expect(managerHtml).toContain('data-dock-key="settings"');

        const accountantHtml = await renderWorkspacePage('finance', {
            workspace: {
                ...managerWorkspace,
                persona: 'accountant',
                roleLabel: 'محاسب',
                permissions: {
                    ...managerWorkspace.permissions,
                    manager: false,
                    owner: false,
                    accountant: true,
                    canTransfer: false,
                    canInternalTransfer: false
                }
            }
        });
        expect(accountantHtml).toContain('data-dock-key="finance"');
        expect(accountantHtml).not.toContain('data-dock-key="services"');
        expect(accountantHtml).not.toContain('data-dock-key="smart_transfer"');
    });

    test('keeps three full palettes in dedicated theme files', () => {
        const files = {
            day: fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'company-portal-theme-day.css'), 'utf8'),
            night: fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'company-portal-theme-night.css'), 'utf8'),
            pharaonic: fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'company-portal-theme-pharaonic.css'), 'utf8')
        };
        expect(files.day).toContain('[data-theme="day"]');
        expect(files.night).toContain('[data-theme="night"]');
        expect(files.pharaonic).toContain('[data-theme="pharaonic"]');
        ['#E8D5B7', '#1A1510', '#C9A227', '#1F6F6A', '#8B3A2F'].forEach((token) => {
            expect(files.pharaonic).toContain(token);
        });
        expect(files.day).toContain('#0F766E');
        expect(files.day).toContain('#E7F1F6');
        expect(files.day).toContain('#1D4ED8');
        expect(files.night).toContain('#0B1426');
        expect(files.night).toContain('#38BDF8');
        expect(files.night).toContain('#2DD4BF');
        const layout = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'company-portal-layout.css'), 'utf8');
        expect(layout).toContain('--cp-touch');
        expect(layout).toContain('env(safe-area-inset-bottom)');
        expect(files.pharaonic).toContain('cp-sand-dust');
        expect(files.pharaonic).toContain('prefers-reduced-motion');
        expect(layout).toContain('cp-app');
        expect(layout).toContain('cp-sidebar');
        expect(layout).toContain('cp-page-hero');
        expect(layout).toContain('cp-service-card');
        expect(layout).toContain('cp-theme-rail');
        expect(layout.length).toBeGreaterThan(8000);
        expect(files.day.length).toBeGreaterThan(1500);
        expect(files.night.length).toBeGreaterThan(1500);
        expect(files.pharaonic.length).toBeGreaterThan(3000);
        expect(files.pharaonic).toContain('clip-path');
        expect(files.pharaonic).toContain('cp-art-ready');
        expect(fs.existsSync(path.join(__dirname, '..', 'public', 'css', 'company-portal.tokens.css'))).toBe(true);
        const alias = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'company-portal.css'), 'utf8');
        expect(alias).not.toMatch(/@import/);
    });

    test('company page templates do not hardcode colors', async () => {
        const pagesDir = path.join(__dirname, '..', 'views', 'client', 'pages');
        const files = fs.readdirSync(pagesDir).filter((name) => name.endsWith('.ejs'));
        files.forEach((name) => {
            const source = fs.readFileSync(path.join(pagesDir, name), 'utf8');
            expect(source).not.toMatch(/style="[^"]*(?:color|background)\s*:\s*#/);
        });
    });
});
