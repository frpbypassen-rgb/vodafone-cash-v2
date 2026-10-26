'use strict';
const path = require('path');
const ejs = require('ejs');
const {
    SERVICE_CATALOG,
    STATUS_META,
    PAGE_META,
    buildNavigation,
    buildCompanyMobileNav,
    buildAgentMobileNav,
    resolvePortalHomeHref,
} = require('../../services/businessPortalService');

const COMPANY_TITLES = {
    services: { title: 'معرض الخدمات', eyebrow: 'قناة واحدة لكل بطاقة' },
    smart_transfer: { title: 'التحويل الذكي', eyebrow: 'من رسالة إلى عملية' },
    transactions: { title: 'غرفة العمليات', eyebrow: 'بحث ومتابعة التنفيذ' },
    settings: { title: 'بيانات المنشأة', eyebrow: 'الملف والتواصل' },
    security: { title: 'أمان الحساب', eyebrow: 'كلمة المرور وMFA والأجهزة' },
    support: { title: 'مركز الدعم', eyebrow: 'مساعدة ومتابعة آمنة' },
    finance: { title: 'مكتب المحاسبة', eyebrow: 'رصيد وكشوف بلا تنفيذ' },
};

const WORKSPACE_VIEW = path.join(__dirname, '../..', 'views', 'company', 'workspace.ejs');

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
        businessProfile: { contactName: 'مدير الاختبار', city: 'طرابلس' },
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
        canManageCustomers: false,
    },
};

const serviceCatalog = SERVICE_CATALOG.map((service) => ({ ...service, rate: 4.85 }));

const renderWorkspacePage = (page, extra = {}) => {
    const workspace = extra.workspace || managerWorkspace;
    const navigation = extra.navigation || buildNavigation(workspace, page);
    return ejs.renderFile(
        workspace.isAgent ? path.join(__dirname, '../..', 'views/agent/workspace.ejs') : WORKSPACE_VIEW,
        {
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
            todaySummary: { totalCount: 0, completedCount: 0, pendingCount: 0, totalEGP: 0, totalLYD: 0 },
            weekSummary: { totalCount: 0, completedCount: 0, pendingCount: 0, totalEGP: 0, totalLYD: 0 },
            monthSummary: { totalCount: 0, completedCount: 0, pendingCount: 0, totalEGP: 0, totalLYD: 0 },
            weekdaySeries: [],
            employeeRoster: [],
            commandCenterChart: { labels: [], counts: [], values: [], showValues: true },
            currentMonthLabel: 'شهر الاختبار',
            recentTransactions: [],
            filters: {
                search: '',
                status: '',
                service: '',
                from: '',
                to: '',
                type: '',
                label: 'اليوم',
                history: '',
            },
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
            companyMobileNav:
                extra.companyMobileNav ||
                (workspace.isAgent
                    ? buildAgentMobileNav(navigation, page).dock
                    : buildCompanyMobileNav(workspace, navigation)),
        },
        {
            filename: workspace.isAgent
                ? path.join(__dirname, '../..', 'views/agent/workspace.ejs')
                : WORKSPACE_VIEW,
        }
    );
};

const buildAgentWorkspace = (role = 'owner') => {
    const { resolveAgentPermissions, dashboardPersona } = require('../../utils/agentPortalPolicy');
    const entity = {
        ...managerWorkspace.entity,
        _id: 'agency-fixture',
        name: 'وكالة الاختبار',
        role: 'agent',
        status: 'active',
    };
    const actor =
        role === 'owner'
            ? entity
            : {
                  _id: `staff-${role}`,
                  role: role === 'manager' ? 'employee' : role,
                  name: 'موظف الاختبار',
                  agentId: entity._id,
                  canManageAgent: role === 'manager',
                  status: 'active',
              };
    const permissions = resolveAgentPermissions(actor);
    return {
        ...managerWorkspace,
        type: 'agent',
        isCompany: false,
        isAgent: true,
        actor,
        entity,
        permissions,
        persona: dashboardPersona(actor),
        entityLabel: 'الوكيل',
        portalLabel: 'بوابة الوكلاء',
        roleLabel:
            role === 'owner'
                ? 'مدير الوكيل'
                : role === 'accountant'
                  ? 'محاسب'
                  : role === 'manager'
                    ? 'مدير تشغيل'
                    : 'موظف',
        forceToday: permissions.employee && !permissions.canViewAllReports,
    };
};

const renderAgentPage = (page, role = 'owner', extra = {}) => {
    const workspace = buildAgentWorkspace(role);
    const { calculateAgencyMetrics } = require('../../services/agencyFinanceService');
    return renderWorkspacePage(page, {
        workspace,
        ...(page === 'finance' ? { pageMeta: { title: 'السجل المالي', eyebrow: 'تتبّع الحركات المالية', icon: 'fa-scale-balanced' } } : {}),
        account: workspace.actor,
        accountType: role === 'owner' ? 'user' : 'agent_staff',
        customersCount: 0,
        activeCustomersCount: 0,
        staffCount: 0,
        activeStaffCount: 0,
        servicePage: { selectedService: 'vodafone' },
        reportScopes: { organization: 'ملخص الوكالة', staff: 'حسب الموظفين', customers: 'حسب العملاء' },
        reportScope: 'organization',
        reportScopeLabel: 'تقرير الوكالة',
        reportRows: [],
        reportTransactions: [],
        centralDownloads: [],
        centralReport: { reportId: 'AGENT-TEST', checksum: 'fixture', issuedAt: new Date() },
        centralSync: { status: 'ready' },
        reportSummary: {
            totalCount: 0,
            completedCount: 0,
            pendingCount: 0,
            cancelledCount: 0,
            totalEGP: 0,
            totalLYD: 0,
        },
        reportAnalytics: { liquiditySeries: [], forecastBalance: 0 },
        serviceBreakdown: [],
        agencyProfitRows: [],
        staffSummary: { total: 0, active: 0, managers: 0, accountants: 0, monthOperations: 0 },
        staffFilters: { search: '', status: '', role: '' },
        periodLabel: 'فترة الاختبار',
        customerSummary: { total: 0, active: 0, positiveBalances: 0, totalDebt: 0, monthVolumeEGP: 0 },
        customers: [],
        customerProfile: {
            customer: { _id: 'customer-fixture', name: 'عميل الاختبار', accountCode: 'U-1001', phone: '0910000001', balance: 100, availableToSpend: 100, reserved: 0, realizedProfit: 0, completedCount: 0, marginPiasters: 3 },
            pricingRows: [],
            transactions: [],
        },
        pendingRequests: [],
        agencyFinance: {
            metrics: calculateAgencyMetrics({ walletBalance: 1250.5 }),
            positiveCustomers: [],
            debtCustomers: [],
            profitRows: [],
            serviceProfitRows: [],
            agencyLedger: [],
            settlementSummary: { received: 0, paid: 0, net: 0 },
        },
        ...extra,
    });
};

module.exports = { renderWorkspacePage, managerWorkspace, buildAgentWorkspace, renderAgentPage };
