'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const {
    isWalletHubSession,
    canRequestRetailDeposit
} = require('../utils/walletHubHelper');
const {
    RETAIL_DOCK,
    buildRetailDock,
    buildRetailMore,
    isRetailMoreActive,
    retailMobileCoversSidebar
} = require('../utils/customerPortalNav');
const {
    applyAdminTxPrivacy,
    adminVisibleTransactionQuery,
    buildAdminAccountHistoryQuery,
    isAdminHiddenPrincipalType,
    isAdminOpsVisibleTransaction,
    isAgencyClientFundingTx,
    isAgencyLogVisibleTransaction,
    isSubClientOperationTx,
    adminListIncludesAgencyDeposit
} = require('../services/adminAccountVisibilityService');
const { loadAdminAccountDirectory } = require('../services/adminAccountDirectoryService');
const { mongoQueryMatches } = require('./mongoQueryMatch');
const { buildLiveQuery } = require('../services/liveOperationsService');
const {
    SERVICE_CATALOG,
    STATUS_META,
    PAGE_META,
    buildNavigation,
    buildCompanyMobileNav,
    resolvePortalHomeHref
} = require('../services/businessPortalService');

const ROOT = path.join(__dirname, '..');
const HUB_SERVICES = path.join(ROOT, 'views/client/hub/services.ejs');
const HUB_TRANSFERS = path.join(ROOT, 'views/client/hub/transfers.ejs');
const HUB_ACCOUNT = path.join(ROOT, 'views/client/hub/account.ejs');
const HUB_SETTINGS = path.join(ROOT, 'views/client/hub/settings.ejs');
const HUB_REPORTS = path.join(ROOT, 'views/client/hub/reports.ejs');
const SUPPORT_VIEW = path.join(ROOT, 'views/client/support.ejs');
const WORKSPACE_VIEW = path.join(ROOT, 'views/client/workspace.ejs');

const SUB_ID = '64b0000000000000000000aa';
const AGENT_ID = '64b0000000000000000000bb';

const retailLocals = (overrides = {}) => ({
    pageTitle: 'بوابة العملاء',
    user: {
        name: 'عميل التجزئة',
        balance: 12.5,
        canViewBalance: true,
        role: 'user',
        accountType: 'user',
        canRequestDeposit: true
    },
    account: { name: 'عميل التجزئة', role: 'user', phone: '0910000000', webUsername: 'retail@ahram.com' },
    accountType: 'user',
    profile: {
        name: 'عميل التجزئة',
        phone: '0910000000',
        username: 'retail@ahram.com',
        accountCode: 'U-1001',
        userRoleLabel: 'عميل فردي',
        accountTypeName: 'عميل مباشر',
        canEditProfile: true,
        address: 'طرابلس'
    },
    isSystemOpen: true,
    csrfToken: 'test-csrf',
    clientTheme: 'day',
    clientThemeMeta: { themeColor: '#E8EEFA' },
    canRequestDeposit: true,
    walletHub: true,
    serviceRates: { vodafone: 4.85, post_card: 4.70, post_account: 4.80, bank_account: 4.75 },
    currentRate: 4.85,
    activeSection: 'profile',
    settingsSuccess: '',
    settingsError: '',
    activeTab: 'operations',
    ...overrides
});

const subClientLocals = () => retailLocals({
    user: {
        name: 'عميل تابع لوكيل',
        balance: 8.25,
        canViewBalance: true,
        role: 'user',
        accountType: 'sub_client',
        canRequestDeposit: false
    },
    account: { name: 'عميل تابع لوكيل', role: 'user', phone: '0920000000', webUsername: 'sub@ahram.com' },
    accountType: 'sub_client',
    profile: {
        name: 'عميل تابع لوكيل',
        phone: '0920000000',
        username: 'sub@ahram.com',
        accountCode: 'S-2001',
        userRoleLabel: 'عميل فردي',
        accountTypeName: 'عميل تابع',
        canEditProfile: true,
        address: 'بنغازي'
    },
    canRequestDeposit: false
});

const chromeMarkers = [
    'cl-app',
    'data-portal="customer"',
    'data-customer-shell',
    'data-customer-dock',
    'data-customer-more',
    'data-dock-key="home"',
    'data-dock-key="transfers"',
    'data-dock-key="services"',
    'data-dock-key="settings"',
    'data-dock-key="more"',
    'href="/client/dashboard"',
    'href="/client/transfers"',
    'href="/client/services"',
    'href="/client/settings"',
    'href="/client/reports"',
    'href="/client/account?tab=operations"',
    'href="/client/support"',
    'التقارير',
    'العمليات وكشف الحساب'
];

const companyWorkspace = {
    type: 'company',
    isCompany: true,
    isAgent: false,
    persona: 'manager',
    roleLabel: 'مدير الشركة',
    entityLabel: 'الشركة',
    portalLabel: 'بوابة الشركات',
    forceToday: false,
    actor: { name: 'مدير الاختبار', webUsername: 'manager@ahram.com' },
    entity: { name: 'شركة الاختبار', accountCode: 'C-1001', balance: 100, creditLimit: 0, phone: '0911111111' },
    permissions: {
        owner: true, manager: true, accountant: false, employee: false,
        canTransfer: true, canInternalTransfer: true, canViewBalance: true,
        canViewReports: true, canRequestDeposit: true, canEditSettings: true
    }
};

const assertCustomerChrome = (html, { reportsActive = false } = {}) => {
    chromeMarkers.forEach((marker) => expect(html).toContain(marker));
    expect(html).not.toContain('cp-app');
    expect(html).not.toContain('data-company-shell');
    expect(html).not.toContain('data-company-dock');
    expect(html).not.toContain('company-portal.tokens.css');
    expect(html).not.toContain('href="/corporate"');
    expect(html).not.toContain('/client/customers');
    expect(html).not.toContain('/client/finance');
    if (reportsActive) {
        expect(html).toContain('data-more-key="reports"');
        expect(html).toContain('data-customer-reports');
    }
};

describe('agency sub-client portal uses retail customer chrome', () => {
    test('wallet hub session helper treats sub_client like a retail customer', () => {
        expect(isWalletHubSession('sub_client')).toBe(true);
        expect(isWalletHubSession('user', 'user')).toBe(true);
        expect(isWalletHubSession('user', 'agent')).toBe(false);
        expect(isWalletHubSession('company')).toBe(false);
        expect(canRequestRetailDeposit('user', 'user')).toBe(true);
        expect(canRequestRetailDeposit('sub_client')).toBe(false);
        expect(canRequestRetailDeposit('user', 'agent')).toBe(false);
        expect(buildRetailDock('home').map((item) => item.key)).toEqual(RETAIL_DOCK.map((item) => item.key));
        expect(buildRetailMore({ canRequestDeposit: false }).some((item) => item.key === 'reports')).toBe(true);
        expect(buildRetailMore({ canRequestDeposit: false }).some((item) => item.key === 'account')).toBe(true);
        expect(isRetailMoreActive('reports')).toBe(true);
        expect(retailMobileCoversSidebar({ canRequestDeposit: true })).toBe(true);
    });

    test('sub_client hub pages render the same cl-app dock, More, reports and account chrome as retail', async () => {
        const retail = subClientLocals();
        const pages = [
            { file: HUB_REPORTS, extras: { activeNav: 'reports' }, reportsActive: true },
            { file: HUB_ACCOUNT, extras: {} },
            { file: HUB_SERVICES, extras: {} },
            { file: HUB_TRANSFERS, extras: { pickService: '' } },
            { file: HUB_SETTINGS, extras: {} },
            { file: SUPPORT_VIEW, extras: { account: retail.account } }
        ];

        for (const page of pages) {
            const html = await ejs.renderFile(page.file, { ...retail, ...page.extras }, { filename: page.file });
            assertCustomerChrome(html, { reportsActive: page.reportsActive });
        }

        const retailHtml = await ejs.renderFile(HUB_REPORTS, retailLocals({ activeNav: 'reports' }), { filename: HUB_REPORTS });
        const subHtml = await ejs.renderFile(HUB_REPORTS, { ...subClientLocals(), activeNav: 'reports' }, { filename: HUB_REPORTS });
        ['data-customer-dock', 'data-customer-more', 'data-more-key="reports"', 'data-dock-key="more"'].forEach((marker) => {
            expect(retailHtml).toContain(marker);
            expect(subHtml).toContain(marker);
        });
    });

    test('company portal stays on cp-app and is not merged into retail cl-app', async () => {
        const navigation = buildNavigation(companyWorkspace, 'services');
        const html = await ejs.renderFile(WORKSPACE_VIEW, {
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

        expect(html).toContain('cp-app');
        expect(html).toContain('data-company-shell');
        expect(html).not.toContain('cl-app');
        expect(html).not.toContain('data-customer-dock');
    });
});

describe('sub_client operations reach admin ops and the agency log', () => {
    const pendingOp = {
        customId: 'ATT-2609-0101',
        status: 'pending',
        transferType: 'vodafone',
        isSubAccountTx: true,
        subAccountId: SUB_ID,
        subAccountName: 'عميل تابع لوكيل',
        companyName: 'وكالة الاختبار'
    };
    const completedOp = { ...pendingOp, status: 'completed', customId: 'ATT-2609-0102' };
    const agencyDeposit = {
        customId: 'SET-123456',
        status: 'deposit',
        isSubAccountTx: true,
        subAccountId: SUB_ID,
        subAccountName: 'عميل تابع لوكيل',
        companyName: 'تسوية وكيل'
    };
    const directOp = {
        customId: 'ATT-2609-0200',
        status: 'pending',
        transferType: 'vodafone',
        isSubAccountTx: false,
        subAccountId: null
    };

    test('create-path fields dual-route a sub_client transfer', () => {
        expect(isSubClientOperationTx(pendingOp)).toBe(true);
        expect(isAdminOpsVisibleTransaction(pendingOp)).toBe(true);
        expect(isAdminOpsVisibleTransaction(completedOp)).toBe(true);
        expect(isAdminOpsVisibleTransaction(directOp)).toBe(true);
        expect(isAgencyLogVisibleTransaction(pendingOp, [SUB_ID])).toBe(true);
        expect(isAgencyLogVisibleTransaction(completedOp, [SUB_ID])).toBe(true);
        expect(isAgencyLogVisibleTransaction(pendingOp, [AGENT_ID])).toBe(false);
        expect(isAgencyLogVisibleTransaction(directOp, [SUB_ID])).toBe(false);

        const liveQuery = applyAdminTxPrivacy({});
        expect(liveQuery.isSubAccountTx).toBeUndefined();
        expect(JSON.stringify(liveQuery.$nor)).toContain('deposit_pending');
        expect(JSON.stringify(liveQuery.$nor)).not.toContain('"$or"');
        liveQuery.$nor.forEach((clause) => {
            expect(clause.$or).toBeUndefined();
            expect(clause.$and).toBeUndefined();
        });
        expect(adminVisibleTransactionQuery({}, { status: 'pending' }).status).toBe('pending');
        expect(adminVisibleTransactionQuery({}, { status: 'pending' }).isSubAccountTx).toBeUndefined();
        expect(mongoQueryMatches(pendingOp, liveQuery)).toBe(true);
        expect(mongoQueryMatches(completedOp, liveQuery)).toBe(true);
        expect(mongoQueryMatches(directOp, liveQuery)).toBe(true);
        expect(mongoQueryMatches(agencyDeposit, liveQuery)).toBe(false);
        expect(mongoQueryMatches(pendingOp, adminVisibleTransactionQuery({}, { status: 'pending' }))).toBe(true);
        expect(mongoQueryMatches(agencyDeposit, adminVisibleTransactionQuery({}, { status: 'pending' }))).toBe(false);

        const transferSource = fs.readFileSync(path.join(ROOT, 'controllers/clientTransactionController.js'), 'utf8');
        expect(transferSource).toMatch(/status: 'pending', isSubAccountTx: isSubAccount/);
        expect(transferSource).toMatch(/subAccountId: isSubAccount \? account\._id : null/);
        expect(transferSource).toMatch(/recordTransferReservation/);

        const agencyFinance = fs.readFileSync(path.join(ROOT, 'services/agencyFinanceService.js'), 'utf8');
        expect(agencyFinance).toMatch(/isSubAccountTx: true, subAccountId: \{ \$in: customerIds \}/);
    });

    test('agency-client deposits stay hidden from admin directory while ops stay visible', () => {
        expect(isAgencyClientFundingTx(agencyDeposit)).toBe(true);
        expect(isAdminOpsVisibleTransaction(agencyDeposit)).toBe(false);
        expect(isAgencyLogVisibleTransaction(agencyDeposit, [SUB_ID])).toBe(true);
        expect(adminListIncludesAgencyDeposit(agencyDeposit)).toBe(false);
        expect(isAdminHiddenPrincipalType('sub_client')).toBe(true);

        const directoryHistory = buildAdminAccountHistoryQuery({
            kind: 'agent',
            account: { _id: AGENT_ID, phone: '0911111111', webUsername: 'agent.a' }
        });
        expect(directoryHistory.isSubAccountTx).toEqual({ $ne: true });
        expect(JSON.stringify(directoryHistory)).not.toContain(SUB_ID);

        const hiddenClient = buildAdminAccountHistoryQuery({ kind: 'subaccount', account: { _id: SUB_ID } });
        expect(hiddenClient).toEqual({ isSubAccountTx: { $ne: true }, _id: null });
    });

    test('pending sub-client transfer matches admin live query and a deposit does not', () => {
        const now = new Date('2026-09-20T20:00:00.000Z');
        const pendingTransfer = {
            ...pendingOp,
            createdAt: now,
            amount: 500
        };
        const fundingDeposit = {
            ...agencyDeposit,
            createdAt: now,
            amount: 200
        };
        const liveAll = buildLiveQuery({ query: { range: 'all' } }, now);
        const livePendingVodafone = buildLiveQuery(
            { query: { status: 'pending', type: 'vodafone', range: 'all' } },
            now
        );
        const liveDefault24h = buildLiveQuery({ query: {} }, now);
        const opsPending = adminVisibleTransactionQuery({}, { status: { $in: ['pending', 'processing', 'accepted', 'completed', 'rejected', 'cancelled_by_admin'] } });

        expect(mongoQueryMatches(pendingTransfer, liveAll)).toBe(true);
        expect(mongoQueryMatches(pendingTransfer, livePendingVodafone)).toBe(true);
        expect(mongoQueryMatches(pendingTransfer, liveDefault24h)).toBe(true);
        expect(mongoQueryMatches(pendingTransfer, opsPending)).toBe(true);
        expect(mongoQueryMatches(fundingDeposit, liveAll)).toBe(false);
        expect(mongoQueryMatches(fundingDeposit, livePendingVodafone)).toBe(false);
        expect(mongoQueryMatches(fundingDeposit, liveDefault24h)).toBe(false);
        expect(mongoQueryMatches(fundingDeposit, opsPending)).toBe(false);
        expect(mongoQueryMatches(directOp, livePendingVodafone)).toBe(true);
    });

    test('admin account directory lists agents not SubAccount clients', async () => {
        const agent = {
            _id: AGENT_ID,
            name: 'وكالة الاختبار',
            role: 'agent',
            phone: '0911111111',
            webUsername: 'agent.a',
            status: 'active'
        };
        const queryResult = (records) => ({
            select: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(records)
        });
        const User = {
            countDocuments: jest.fn((filter) => Promise.resolve(filter.role === 'agent' ? 1 : 0)),
            find: jest.fn(() => queryResult([agent]))
        };
        const ClientCompany = {
            countDocuments: jest.fn(() => Promise.resolve(0)),
            find: jest.fn(() => queryResult([]))
        };
        const SubAccount = {
            countDocuments: jest.fn(() => Promise.resolve(1)),
            find: jest.fn(() => queryResult([{ _id: SUB_ID, name: 'عميل تابع لوكيل' }]))
        };

        const directory = await loadAdminAccountDirectory({ User, ClientCompany, SubAccount }, { section: 'agents' });
        expect(directory.agents).toEqual([agent]);
        expect(directory.subAccounts).toEqual([]);
        expect(JSON.stringify(directory)).not.toContain('عميل تابع لوكيل');
        expect(SubAccount.find).not.toHaveBeenCalled();
    });
});
