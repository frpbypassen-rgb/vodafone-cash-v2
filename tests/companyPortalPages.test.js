'use strict';

const path = require('path');
const ejs = require('ejs');
const {
    SERVICE_CATALOG,
    STATUS_META,
    PAGE_META,
    buildNavigation,
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
    portalLabel: 'غرفة الشركات',
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

const renderWorkspacePage = (page, extra = {}) => ejs.renderFile(WORKSPACE_VIEW, {
    page,
    pageMeta: { ...PAGE_META[page], ...(COMPANY_TITLES[page] || {}) },
    workspace: managerWorkspace,
    portalHomeHref: resolvePortalHomeHref(managerWorkspace),
    navigation: buildNavigation(managerWorkspace, page),
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
    ...extra
}, { filename: WORKSPACE_VIEW });

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
        const walk = (stack) => {
            stack.forEach((layer) => {
                if (layer.route?.path && layer.route.methods.get) {
                    registered.push(layer.route.path);
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
            '/company/deposits'
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
});
