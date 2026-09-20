'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const {
    SERVICE_CATALOG,
    STATUS_META,
    PAGE_META,
    buildNavigation,
    buildCompanyMobileNav,
    resolvePortalHomeHref
} = require('../services/businessPortalService');
const {
    RETAIL_SIDEBAR_HREFS,
    AGENT_DOCK_KEYS,
    buildRetailDock,
    buildRetailMore,
    isRetailMoreActive,
    retailMobileCoversSidebar,
    buildAgentMobileNav,
    agentMobileCoversSidebar,
    rewriteCustomerNotificationHref
} = require('../utils/customerPortalNav');

const ROOT = path.join(__dirname, '..');
const WORKSPACE_VIEW = path.join(ROOT, 'views/client/workspace.ejs');
const WORKSPACE_HEAD = path.join(ROOT, 'views/client/partials/workspace_head.ejs');
const DASHBOARD_VIEW = path.join(ROOT, 'views/client/dashboard.ejs');
const HUB_SERVICES = path.join(ROOT, 'views/client/hub/services.ejs');
const HUB_TRANSFERS = path.join(ROOT, 'views/client/hub/transfers.ejs');
const HUB_ACCOUNT = path.join(ROOT, 'views/client/hub/account.ejs');
const HUB_SETTINGS = path.join(ROOT, 'views/client/hub/settings.ejs');
const SUPPORT_VIEW = path.join(ROOT, 'views/client/support.ejs');
const CUSTOMER_STYLES = path.join(ROOT, 'views/client/partials/customer_portal_styles.ejs');
const COMPANY_HEAD = path.join(ROOT, 'views/client/partials/workspace_head.ejs');
const BOTTOM_NAV = path.join(ROOT, 'views/client/partials/wallet_hub_bottom_nav.ejs');
const MORE_SHEET = path.join(ROOT, 'views/client/partials/customer_more_sheet.ejs');
const NOTIFICATIONS = path.join(ROOT, 'views/client/partials/customer_notifications.ejs');
const LAYOUT_CSS = path.join(ROOT, 'public/css/client-portal-layout.css');
const PORTAL_JS = path.join(ROOT, 'public/js/client-portal.js');

const agentWorkspace = {
    type: 'agent',
    isCompany: false,
    isAgent: true,
    persona: 'manager',
    roleLabel: 'وكيل',
    entityLabel: 'الوكالة',
    portalLabel: 'بوابة العملاء',
    forceToday: false,
    actor: { name: 'وكيل الاختبار', webUsername: 'agent@ahram.com', preferences: { clientTheme: 'night' } },
    entity: {
        name: 'وكالة الاختبار',
        accountCode: 'A-1001',
        balance: 820.25,
        creditLimit: 0,
        phone: '0911111111',
        businessProfile: { contactName: 'وكيل الاختبار', city: 'طرابلس' }
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
        canRequestDeposit: false,
        canEditSettings: true,
        canManageCustomers: true
    }
};

const companyWorkspace = {
    ...agentWorkspace,
    type: 'company',
    isCompany: true,
    isAgent: false,
    persona: 'manager',
    roleLabel: 'مدير الشركة',
    entityLabel: 'الشركة',
    portalLabel: 'بوابة الشركات',
    actor: { name: 'مدير الاختبار', webUsername: 'manager@ahram.com' },
    entity: { ...agentWorkspace.entity, name: 'شركة الاختبار', accountCode: 'C-1001' }
};

const renderAgentWorkspace = (page = 'overview') => ejs.renderFile(WORKSPACE_VIEW, {
    page,
    pageMeta: { ...PAGE_META.overview, title: 'الرئيسية', eyebrow: 'عمل اليوم' },
    workspace: agentWorkspace,
    portalHomeHref: resolvePortalHomeHref(agentWorkspace),
    navigation: buildNavigation(agentWorkspace, page),
    customerMobileNav: buildAgentMobileNav(buildNavigation(agentWorkspace, page), page),
    companyMobileNav: [],
    statusMeta: STATUS_META,
    serviceCatalog: SERVICE_CATALOG.map((service) => ({ ...service, rate: 4.85 })),
    serviceRates: { vodafone: 4.85 },
    ratesUpdatedAt: new Date(),
    pendingRateUpdate: null,
    lowBalanceAlert: null,
    systemOpen: true,
    query: {},
    csrfToken: 'test-csrf',
    now: new Date(),
    companyTheme: null,
    clientTheme: 'night',
    clientThemeMeta: { themeColor: '#070B14' },
    todaySummary: { totalCount: 2, completedCount: 1, pendingCount: 1, totalEGP: 100, totalLYD: 20 },
    monthSummary: { totalCount: 2, completedCount: 1, pendingCount: 1, totalEGP: 100, totalLYD: 20 },
    currentMonthLabel: 'شهر الاختبار',
    recentTransactions: [],
    customersCount: 0,
    activeCustomersCount: 0,
    pendingRequests: 0,
    staffCount: 0,
    activeStaffCount: 0,
    formatInputDate: () => ''
}, { filename: WORKSPACE_VIEW });

const renderCompanyWorkspace = () => {
    const navigation = buildNavigation(companyWorkspace, 'services');
    return ejs.renderFile(WORKSPACE_VIEW, {
        page: 'services',
        pageMeta: { ...PAGE_META.services, title: 'معرض الخدمات', eyebrow: 'قناة واحدة لكل بطاقة' },
        workspace: companyWorkspace,
        portalHomeHref: resolvePortalHomeHref(companyWorkspace),
        navigation,
        companyMobileNav: buildCompanyMobileNav(companyWorkspace, navigation),
        customerMobileNav: null,
        statusMeta: STATUS_META,
        serviceCatalog: SERVICE_CATALOG.map((service) => ({ ...service, rate: 4.85 })),
        serviceRates: { vodafone: 4.85 },
        ratesUpdatedAt: new Date(),
        pendingRateUpdate: null,
        lowBalanceAlert: null,
        systemOpen: true,
        query: {},
        csrfToken: 'test-csrf',
        now: new Date(),
        companyTheme: 'day',
        clientTheme: null,
        todaySummary: { totalCount: 0, completedCount: 0, pendingCount: 0, totalEGP: 0, totalLYD: 0 },
        monthSummary: { totalCount: 0, completedCount: 0, pendingCount: 0, totalEGP: 0, totalLYD: 0 },
        currentMonthLabel: 'شهر الاختبار',
        recentTransactions: [],
        formatInputDate: () => ''
    }, { filename: WORKSPACE_VIEW });
};

describe('customer portal mobile chrome and exclusivity', () => {
    test('retail dock + More cover every desktop sidebar href', () => {
        expect(retailMobileCoversSidebar({ canRequestDeposit: true })).toBe(true);
        const dockHrefs = buildRetailDock('home').map((item) => item.href);
        const moreHrefs = buildRetailMore({ canRequestDeposit: true }).map((item) => item.href);
        RETAIL_SIDEBAR_HREFS.forEach((href) => {
            const covered = [...dockHrefs, ...moreHrefs].some((item) => (
                item === href || item.startsWith(href.split('?')[0])
            ));
            expect(covered).toBe(true);
        });
        expect(isRetailMoreActive('support')).toBe(true);
        expect(isRetailMoreActive('account')).toBe(true);
        expect(isRetailMoreActive('home')).toBe(false);
    });

    test('agent workspace dock + More cover every sidebar item', () => {
        const navigation = buildNavigation(agentWorkspace, 'overview');
        expect(agentMobileCoversSidebar(navigation, 'overview')).toBe(true);
        const { dock, more } = buildAgentMobileNav(navigation, 'finance');
        expect(dock.map((item) => item.key)).toEqual(AGENT_DOCK_KEYS.filter((key) => navigation.some((item) => item.key === key)));
        expect(more.some((item) => item.key === 'finance')).toBe(true);
        expect(more.some((item) => item.key === 'settings')).toBe(true);
        expect(more.some((item) => item.key === 'customers')).toBe(true);
        expect(dock.some((item) => item.key === 'support')).toBe(true);
    });

    test('agent workspace paints one customer shell with bell, dock, and More', async () => {
        const html = await renderAgentWorkspace('overview');
        expect(html).toContain('data-customer-shell');
        expect(html).toContain('cl-app');
        expect(html).toContain('data-customer-bell');
        expect(html).toContain('data-customer-dock');
        expect(html).toContain('data-customer-more');
        expect(html).toContain('data-cl-more-open');
        expect(html).toContain('data-dock-key="support"');
        expect(html).toContain('data-dock-key="more"');
        expect(html).toContain('/client/finance');
        expect(html).toContain('/client/customers');
        expect(html).toContain('/client/settings');
        expect(html).toContain('20260920-cl-m2');
        expect(html).not.toContain('company-portal.tokens.css');
        expect(html).not.toContain('company-portal-layout.css');
        expect(html).not.toContain('data-company-bell');
        expect(html).not.toContain('data-company-dock');
        expect(html).not.toContain('href="/corporate"');
    });

    test('customer styles and JS stay exclusive of company chrome', async () => {
        const styles = fs.readFileSync(CUSTOMER_STYLES, 'utf8');
        const layout = fs.readFileSync(LAYOUT_CSS, 'utf8');
        const portalJs = fs.readFileSync(PORTAL_JS, 'utf8');
        const head = await ejs.renderFile(WORKSPACE_HEAD, {
            pageMeta: { title: 'الرئيسية' },
            workspace: { isCompany: false },
            clientTheme: 'day',
            clientThemeMeta: { themeColor: '#E8EEFA' }
        }, { filename: WORKSPACE_HEAD });
        const companyHead = await ejs.renderFile(COMPANY_HEAD, {
            pageMeta: { title: 'معرض الخدمات' },
            workspace: { isCompany: true },
            companyTheme: 'day',
            companyThemeMeta: { themeColor: '#E7F1F6' }
        }, { filename: COMPANY_HEAD });

        expect(styles).toContain('data-customer-shell-css');
        expect(styles).toContain('20260920-cl-m2');
        expect(styles).not.toContain('href="/css/company-portal');
        expect(head).toContain('client-portal.tokens.css');
        expect(head).not.toContain('company-portal.tokens.css');
        expect(companyHead).toContain('company-portal.tokens.css');
        expect(companyHead).not.toContain('client-portal.tokens.css');
        expect(companyHead).not.toContain('client-portal-2027.css');
        expect(head).toContain('client-portal-2027.css');
        expect(layout).toContain('data-legacy-wallet-shell-dock');
        expect(layout).toContain('nav.bottom-nav-mobile:not(.cl-dock)');
        expect(layout).not.toContain('data-portal="company"');
        expect(portalJs).toContain('data-customer-bell');
        expect(portalJs).toContain('/client/api/notifications');
    });

    test('company workspace is untouched by customer dock and bell', async () => {
        const html = await renderCompanyWorkspace();
        expect(html).toContain('data-company-shell');
        expect(html).toContain('cp-app');
        expect(html).toContain('data-company-bell');
        expect(html).toContain('data-company-dock');
        expect(html).not.toContain('data-customer-bell');
        expect(html).not.toContain('data-customer-dock');
        expect(html).not.toContain('data-customer-more');
        expect(html).not.toContain('client-portal.tokens.css');
        expect(html).not.toContain('cl-app');
    });

    test('retail hub templates keep one dock, More, and notification partial', () => {
        const dashboard = fs.readFileSync(DASHBOARD_VIEW, 'utf8');
        const services = fs.readFileSync(HUB_SERVICES, 'utf8');
        const transfers = fs.readFileSync(HUB_TRANSFERS, 'utf8');
        const account = fs.readFileSync(HUB_ACCOUNT, 'utf8');
        const settings = fs.readFileSync(HUB_SETTINGS, 'utf8');
        const support = fs.readFileSync(SUPPORT_VIEW, 'utf8');
        const dock = fs.readFileSync(BOTTOM_NAV, 'utf8');
        const more = fs.readFileSync(MORE_SHEET, 'utf8');
        const bell = fs.readFileSync(NOTIFICATIONS, 'utf8');

        [dashboard, services, transfers, account, settings, support].forEach((html) => {
            expect(html).toContain('cl-app');
            expect(html).toContain('data-portal="customer"');
            expect(html).toContain('wallet_hub_bottom_nav');
        });
        expect(dashboard).toContain('wallet_hub_more');
        expect(services).toContain('wallet_hub_layout_end');
        expect(support).toContain('wallet_hub_mobile_header');
        expect(support).not.toContain('wallet_shell_topbar');
        const hubShell = fs.readFileSync(path.join(ROOT, 'views/client/partials/wallet_hub_hub_shell_start.ejs'), 'utf8');
        expect(hubShell).not.toContain('d-none d-md-grid');
        expect(fs.readFileSync(LAYOUT_CSS, 'utf8')).toContain('client-hub-shell.d-none');
        expect(dock).toContain('data-cl-more-open');
        expect(dock).toContain('data-dock-key="more"');
        expect(dock).toContain('/client/dashboard');
        expect(dock).toContain('/client/transfers');
        expect(dock).toContain('/client/services');
        expect(dock).toContain('/client/settings');
        expect(more).toContain('data-customer-more');
        expect(bell).toContain('data-customer-bell');
        expect(bell).toContain('لا إشعارات حالياً');
    });

    test('rewrites company-oriented notification hrefs for retail inbox', () => {
        expect(rewriteCustomerNotificationHref('/client/transactions', { retail: true })).toBe('/client/account?tab=operations');
        expect(rewriteCustomerNotificationHref('/client/company/deposits', { retail: true })).toBe('/client/account?tab=deposits-new');
        expect(rewriteCustomerNotificationHref('/client/support', { retail: true })).toBe('/client/support');
        expect(rewriteCustomerNotificationHref('/client/transactions', { retail: false })).toBe('/client/transactions');
    });
});
