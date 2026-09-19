'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const {
    resolveAccountClientTheme,
    resolveClientTheme,
    readStoredClientTheme,
    buildClientThemePreferenceUpdate,
    clientThemeLocals
} = require('../utils/clientPortalTheme');
const {
    SERVICE_CATALOG,
    STATUS_META,
    PAGE_META,
    buildNavigation,
    resolvePortalHomeHref
} = require('../services/businessPortalService');

const WORKSPACE_HEAD = path.join(__dirname, '..', 'views', 'client', 'partials', 'workspace_head.ejs');
const WORKSPACE_VIEW = path.join(__dirname, '..', 'views', 'client', 'workspace.ejs');
const DASHBOARD_VIEW = path.join(__dirname, '..', 'views', 'client', 'dashboard.ejs');

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

describe('customer portal theme SSR and preferences', () => {
    test('reads preferences.clientTheme without touching companyTheme', () => {
        expect(readStoredClientTheme({ preferences: { clientTheme: 'night', companyTheme: 'day' } })).toBe('night');
        expect(resolveAccountClientTheme({ preferences: { clientTheme: 'day' } }, 'night')).toBe('day');
        expect(buildClientThemePreferenceUpdate('night')).toEqual({ 'preferences.clientTheme': 'night' });
        expect(clientThemeLocals({ preferences: { clientTheme: 'pharaonic' } }).clientTheme).toBe('pharaonic');
    });

    test('server value wins after login', () => {
        expect(resolveClientTheme({
            stored: 'pharaonic',
            server: 'night',
            serverWins: true
        })).toBe('night');
        expect(resolveClientTheme({
            stored: 'pharaonic',
            server: 'night',
            serverWins: false
        })).toBe('pharaonic');
    });

    test('agent workspace head loads customer CSS and not company chrome', async () => {
        const head = await ejs.renderFile(WORKSPACE_HEAD, {
            pageMeta: { title: 'الرئيسية' },
            workspace: { isCompany: false, persona: 'manager' },
            clientTheme: 'night',
            clientThemeMeta: { themeColor: '#070B14' }
        }, { filename: WORKSPACE_HEAD });

        expect(head).toContain('/css/client-portal.tokens.css');
        expect(head).toContain('/css/client-portal-layout.css');
        expect(head).toContain('/css/client-portal-theme-day.css');
        expect(head).toContain('/css/client-portal-theme-night.css');
        expect(head).toContain('/css/client-portal-theme-pharaonic.css');
        expect(head).toContain('20260919-cl1');
        expect(head).not.toContain('company-portal.tokens.css');
        expect(head).not.toContain('company-portal-layout.css');
        expect(head).toContain('ahram_client_theme');
        expect(head).toContain('valid.includes(server) ? server');
    });

    test('agent workspace paints cl-app and server theme before scripts', async () => {
        const html = await ejs.renderFile(WORKSPACE_VIEW, {
            page: 'overview',
            pageMeta: { ...PAGE_META.overview, title: 'الرئيسية', eyebrow: 'عمل اليوم' },
            workspace: agentWorkspace,
            portalHomeHref: resolvePortalHomeHref(agentWorkspace),
            navigation: buildNavigation(agentWorkspace, 'overview'),
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

        expect(html).toContain('data-customer-shell');
        expect(html).toContain('cl-app');
        expect(html).toContain('cl-sidebar');
        expect(html).toContain('data-portal="customer"');
        expect(html).toContain('data-theme="night"');
        expect(html).toContain('data-client-theme-switcher');
        expect(html).toContain('/js/client-portal.js?v=20260919-cl1');
        expect(html).not.toContain('data-company-shell');
        expect(html).not.toContain('company-portal.js');
        expect(html).not.toContain('href="/corporate"');
    });

    test('retail dashboard shell uses customer portal chrome and three themes', () => {
        const html = fs.readFileSync(DASHBOARD_VIEW, 'utf8');
        expect(html).toContain('data-portal="customer"');
        expect(html).toContain('data-theme="<%= typeof clientTheme !== \'undefined\' && clientTheme ? clientTheme : \'day\' %>"');
        expect(html).toContain('cl-app');
        expect(html).toContain('customer_portal_styles');
        expect(html).toContain('customer_theme_boot');
        expect(html).toContain('/js/client-portal.js?v=20260919-cl1');
    });

    test('theme files stay split and Pharaonic art is lazy plus motion-safe', () => {
        const day = fs.readFileSync(path.join(__dirname, '..', 'public/css/client-portal-theme-day.css'), 'utf8');
        const night = fs.readFileSync(path.join(__dirname, '..', 'public/css/client-portal-theme-night.css'), 'utf8');
        const pharaonic = fs.readFileSync(path.join(__dirname, '..', 'public/css/client-portal-theme-pharaonic.css'), 'utf8');
        const layout = fs.readFileSync(path.join(__dirname, '..', 'public/css/client-portal-layout.css'), 'utf8');
        expect(day).toContain('#3730A3');
        expect(day).toContain('#E8EEFA');
        expect(day).toContain('#0F766E');
        expect(night).toContain('#070B14');
        expect(night).toContain('#22D3EE');
        expect(pharaonic).toContain('#D4A017');
        expect(pharaonic).toContain('#0E7C75');
        expect(pharaonic).toContain('#1C1610');
        expect(pharaonic).toContain('cl-art-ready');
        expect(pharaonic).toContain('prefers-reduced-motion');
        expect(layout).toContain('--cl-touch');
        expect(layout).toContain('overflow-x: hidden');
        expect(layout).toContain('cl-app');
        expect(layout).not.toMatch(/url\(['"][^)]+\.(png|jpe?g|webp)/i);
        expect(layout).not.toContain('data-portal="company"');
    });
});
