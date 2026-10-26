const { readPortalAsset } = require('./helpers/portalAssetSources');
'use strict';

describe('selected company internal layouts', () => {
    test('every company settings category has an existing panel', async () => {
        const html = await renderWorkspacePage('settings');
        const categories = html.match(/<nav class="cm-settings-categories"[\s\S]*?<\/nav>/)[0];
        for (const match of categories.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${match[1]}"`);
    });
    test.each(['vodafone', 'bank_account', 'post_account', 'post_card', 'sefa_niger', 'bankak_sudan'])('renders %s with one transfer form and live cost summary', async (service) => {
        const html = await renderWorkspacePage('service_workbench', {
            servicePage: { selectedService: service, isolated: true }
        });
        expect((html.match(/id="businessTransferForm"/g) || []).length).toBe(1);
        expect((html.match(/id="transferSubmitButton"/g) || []).length).toBe(1);
        expect(html).toContain('cm-transfer-summary');
        expect(html).toContain('id="costEstimate"');
        expect(html).toContain('id="transferAmountLyd"');
        // Each isolated page must pass its service into the included form,
        // otherwise bank and international transfers silently use the cash layout.
        if (service === 'bank_account') expect(html).toContain('id="transferBankMethod"');
        expect(html).toContain('agent-cash-balance');
        if (service === 'bankak_sudan') expect(html).toContain('cm-bankak-amount');
        for (const id of ['transferDestination', 'transferBankMethod', 'transferSubtype', 'transferIdentityImage', 'transferSefaAcknowledgement']) {
            expect((html.match(new RegExp('id="' + id + '"', 'g')) || []).length).toBe(1);
        }
    });

    test('deposit tracking only marks a ledger deposit as approved', async () => {
        const pending = await renderWorkspacePage('deposits', {
            pendingDepositCount: 1,
            depositRequests: [{ customId: 'PENDING', source: 'support', status: 'deposit_pending', amount: 125, note: '<script>alert(1)</script>' }]
        });
        expect(pending).toContain('بانتظار اعتماد الرصيد');
        expect(pending).not.toContain('تم اعتماد الإيداع');
        expect(pending).toContain('&lt;script&gt;');
        const approved = await renderWorkspacePage('deposits', {
            pendingDepositCount: 0,
            depositRequests: [{ customId: 'APPROVED', status: 'deposit', amount: 125 }]
        });
        expect(approved).toContain('تم اعتماد الإيداع');
        expect(approved).toContain('LYD');
    });

    test('operation table preserves per-service currency and hides cost without permission', async () => {
        const html = await renderWorkspacePage('transactions', {
            workspace: { ...managerWorkspace, permissions: { ...managerWorkspace.permissions, canViewBalance: false } },
            transactions: [{ _id: 'test', customId: 'TEST-SEFA', transferType: 'sefa_niger', amount: 1000, costLYD: 987.123, status: 'pending', createdAt: new Date() }]
        });
        expect(html).toContain('bw-transactions-table');
        expect(html).toContain('XOF');
        expect(html).not.toContain('987.123');
        expect(html).not.toContain('data-label="التكلفة"');
    });

    test.each(['organization', 'staff'])('renders %s report with its selected analysis layout', async (scope) => {
        const html = await renderWorkspacePage('reports', {
            reportScope: scope, reportScopes: {}, reportScopeLabel: 'تقرير اختبار',
            centralAdminReport: null, centralAdminReportInput: {}, companyReportEmployees: [],
            centralDownloads: [], centralReport: { reportId: 'R-1', checksum: 'test', issuedAt: new Date() },
            centralSync: { status: 'ready' },
            reportSummary: { totalCount: 4, completedCount: 3, pendingCount: 1, cancelledCount: 0, totalEGP: 1000, totalLYD: 157.48 },
            reportAnalytics: { liquiditySeries: [], totalIncoming: 0, totalOutgoing: 0 },
            reportRows: [{ key: 'موظف تجريبي', totalCount: 4, completedCount: 3, pendingCount: 1, cancelledCount: 0, totalEGP: 1000, totalLYD: 157.48 }],
            serviceBreakdown: [], reportTransactions: []
        });
        expect(html).toContain('موظف تجريبي');
        expect(html).toContain('157.48');
        if (scope === 'staff') {
            expect(html).toContain('cm-performance-meter');
            expect(html).toContain('75%');
            expect(html).toContain('agent-report-row');
        } else {
            expect(html).toContain('id="liquidityChart"');
        }
    });
});


const path = require('path');
const fs = require('fs');
const { renderWorkspacePage, managerWorkspace } = require('./helpers/agentPortalFixtures');

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
                if (layer.handle?.stack) walk(layer.handle.stack);
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

    test('modern employee home hides company balance and deposits', async () => {
        const html = await renderWorkspacePage('services', {
            workspace: { ...managerWorkspace, persona: 'employee', forceToday: true,
                permissions: { employee: true, canTransfer: true, canViewBalance: false, canViewReports: false } }
        });
        expect(html).not.toContain('class="cm-wallet-amount"');
        expect(html).not.toContain('class="cm-stat deposit"');
        expect(html).not.toContain('href="/client/staff"');
        expect(html).not.toContain('آخر عملياتي اليوم');
        expect(html).toContain('href="/client/services/cash"');
    });

    test('shares one themed shell with switcher, bell, sidebar, and mobile dock', async () => {
        const html = await renderWorkspacePage('services');
        expect(html).toContain('data-company-shell');
        expect(html).toContain('cp-app');
        expect(html).toContain('cp-sidebar');
        expect(html).toContain('cm-header');
        expect(html).toContain('cm-service-grid');
        expect(html).toContain('cm-service');
        expect(html).toContain('/css/company-modern.css');
        expect(html).toContain('cp-theme-rail');
        expect(html).toContain('/css/company-portal.tokens.css');
        expect(html).toContain('/css/company-portal-layout.css');
        expect(html).toContain('/css/company-portal-theme-day.css');
        expect(html).toContain('/css/company-portal-theme-night.css');
        expect(html).toContain('/css/company-portal-theme-pharaonic.css');
        expect(html).toContain('/css/company-portal.tokens.css?v=');
        expect(html).not.toContain('client-portal-2027.css');
        expect(html).not.toContain('client-company-os.css');
        expect(html).not.toContain('client-portal.tokens.css');
        expect(html).not.toContain('cl-app');
        expect(html).not.toContain('data-customer-shell');
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

    test('team page uses compact searchable rows', async () => {
        const html = await renderWorkspacePage('staff', {
            staffSummary: { total: 3, active: 2, managers: 1, accountants: 1, monthOperations: 12 },
            staffFilters: { search: '', role: '', status: '' },
            staff: []
        });
        expect(html).toContain('data-staff-search');
        expect(html).toContain('الموظفون');
        expect(html).not.toContain('<table class="bw-table">');
        expect(html).not.toContain('cos-ledger-office');
        expect(html).not.toContain('cos-ops-card');
    });

    test('filters mobile dock items by company role', async () => {
        const managerHtml = await renderWorkspacePage('services');
        expect(managerHtml).toContain('data-dock-key="services"');
        expect(managerHtml).toContain('href="/client/reports"');
        expect(managerHtml).toContain('id="agentMoreMenu"');
        expect(managerHtml).toContain('href="/client/settings"');
        expect(managerHtml).toContain('fa-file-invoice');
        expect(managerHtml).not.toContain('data-dock-key="smart_transfer"');

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
        expect(accountantHtml).toContain('href="/client/reports"');
        expect(accountantHtml).not.toContain('data-dock-key="services"');
        expect(accountantHtml).not.toContain('data-dock-key="smart_transfer"');
    });

    test('keeps three full palettes in dedicated theme files', () => {
        const files = {
            day: readPortalAsset(path.join(__dirname, '..', 'public', 'css', 'company-portal-theme-day.css')),
            night: readPortalAsset(path.join(__dirname, '..', 'public', 'css', 'company-portal-theme-night.css')),
            pharaonic: readPortalAsset(path.join(__dirname, '..', 'public', 'css', 'company-portal-theme-pharaonic.css'))
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
        const layout = readPortalAsset(path.join(__dirname, '..', 'public', 'css', 'company-portal-layout.css'));
        expect(layout).toContain('--cp-touch');
        expect(layout).toContain('env(safe-area-inset-bottom)');
        expect(layout).toContain('letter-spacing: 0 !important');
        expect(layout).toContain('clip-path: inset(50%)');
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
        const alias = readPortalAsset(path.join(__dirname, '..', 'public', 'css', 'company-portal.css'));
        expect(alias).not.toMatch(/@import/);
    });

    test('command center dashboard renders period cards, weekday chart, and employee status', async () => {
        const html = await renderWorkspacePage('overview', {
            pageMeta: { title: 'مركز قيادة الشركة', eyebrow: 'لوحة موحّدة للتشغيل', icon: 'fa-building-shield' },
            todaySummary: { totalCount: 4, completedCount: 3, pendingCount: 1, totalEGP: 1200, totalLYD: 180 },
            weekSummary: { totalCount: 11, completedCount: 9, pendingCount: 2, totalEGP: 5400, totalLYD: 800 },
            monthSummary: { totalCount: 21, completedCount: 18, pendingCount: 2, totalEGP: 12000, totalLYD: 1800 },
            weekdaySeries: [
                { date: '2026-09-13', label: 'الأحد', shortLabel: 'أحد', count: 2, amountEGP: 400 }
            ],
            employeeRoster: [{
                id: '1',
                name: 'سالم التنفيذي',
                webUsername: 'salem@ahram.com',
                roleLabel: 'موظف تنفيذ',
                accountActive: true,
                accountLabel: 'نشط',
                presenceLabel: 'متصل',
                presenceTone: 'success',
                isOnline: true,
                lastSeenAt: new Date('2026-09-19T10:00:00Z'),
                ops: { todayCount: 2, totalCount: 8, completedCount: 7, totalEGP: 2100 }
            }],
            commandCenterChart: { labels: ['أحد'], counts: [2], values: [400], showValues: true },
            pendingDepositCount: 1,
            staffCount: 3,
            activeStaffCount: 2
        });
        expect(html).toContain('لوحة تشغيل الشركة');
        expect(html).toContain('اليوم');
        expect(html).toContain('الأسبوع');
        expect(html).toContain('الشهر');
        expect(html).toContain('commandCenterWeekChart');
        expect(html).toContain('موظفون الشركة');
        expect(html).toContain('سالم التنفيذي');
        expect(html).toContain('متصل');
        expect(html).toContain('chart.js');
        expect(html).toContain('مركز القيادة');
        expect(html).not.toContain('أمر صوتي');
        expect(html).not.toContain('href="/corporate"');
        expect(html).not.toContain('ao-service-launcher');
    });

    test('service workbench keeps focus and secure send and drops voice order', async () => {
        const html = await renderWorkspacePage('service_workbench', {
            servicePage: { isolated: true, selectedService: 'vodafone' },
            transferHub: { suggestedReasons: [], recentOperations: [] }
        });
        expect(html).toContain('وضع التركيز');
        expect(html).toContain('إرسال آمن');
        expect(html).toContain('data-focus-mode');
        expect(html).not.toContain('أمر صوتي');
        expect(html).not.toContain('data-voice-transfer');
    });

    test('company reports show proof thumbnails from authorized proxy URLs', async () => {
        const html = await renderWorkspacePage('reports', {
            reportScope: 'organization',
            reportScopeLabel: 'كشف الحساب',
            reportScopes: { organization: 'كشف الحساب' },
            centralAdminReport: null,
            centralDownloads: [],
            centralReport: { reportId: 'R-1', checksum: 'abc', issuedAt: new Date() },
            centralSync: { status: 'ready' },
            filters: { from: '', to: '', month: '2026-09', label: 'شهر 9 / 2026', scope: 'organization' },
            reportSummary: { totalCount: 1, completedCount: 1, pendingCount: 0, cancelledCount: 0, totalEGP: 100, totalLYD: 20 },
            reportAnalytics: { forecastBalance: 0, totalIncoming: 0, totalOutgoing: 0, netMovement: 0, liquiditySeries: [] },
            reportRows: [],
            serviceBreakdown: [],
            agencyProfitRows: [],
            companyReportEmployees: [],
            centralAdminReportInput: { dateType: 'month', dateValue: '2026-09' },
            reportTransactions: [{
                _id: '64f123456789012345678901',
                customId: 'OP-1001',
                status: 'completed',
                transferType: 'vodafone',
                amount: 500,
                employeeName: 'موظف الشركة',
                createdAt: new Date('2026-09-19T10:00:00Z'),
                hasProof: true,
                receiptImages: [{
                    index: 0,
                    label: 'صورة الإثبات 1',
                    url: '/client/proxy/image/64f123456789012345678901/0'
                }]
            }]
        });
        expect(html).toContain('صورة الإثبات');
        expect(html).toContain('/client/proxy/image/64f123456789012345678901/0');
        expect(html).toContain('data-receipt-lightbox');
        expect(html).toContain('id="receiptLightbox"');
        expect(html).toContain('OP-1001');
        expect(html).toContain('الإثبات');
        expect(html).toContain('/css/company-portal.tokens.css?v=');
        expect(html).not.toContain('href="/corporate"');
        expect(html).not.toContain('proofs/official.svg');
    });

    test('company reports remain accessible from the phone More menu', async () => {
        const html = await renderWorkspacePage('reports', {
            reportScope: 'organization',
            reportScopeLabel: 'كشف الحساب',
            reportScopes: { organization: 'كشف الحساب' },
            centralAdminReport: null,
            centralDownloads: [],
            centralReport: { reportId: 'R-1', checksum: 'abc', issuedAt: new Date() },
            centralSync: { status: 'ready' },
            filters: { from: '', to: '', month: '2026-09', label: 'شهر 9 / 2026', scope: 'organization' },
            reportSummary: { totalCount: 0, completedCount: 0, pendingCount: 0, cancelledCount: 0, totalEGP: 0, totalLYD: 0 },
            reportAnalytics: { forecastBalance: 0, totalIncoming: 0, totalOutgoing: 0, netMovement: 0, liquiditySeries: [] },
            reportRows: [],
            serviceBreakdown: [],
            agencyProfitRows: [],
            companyReportEmployees: [],
            centralAdminReportInput: { dateType: 'month', dateValue: '2026-09' },
            reportTransactions: []
        });
        expect(html).toContain('href="/client/reports"');
        expect(html).toContain('data-company-dock');
        expect(html).toContain('id="agentMoreMenu"');
        expect(html).toContain('fa-file-invoice');
        expect(html).toContain('كشف الحساب');
        expect(html).toContain('تنزيل كشف الإدارة الشامل');
        expect(html).not.toContain('client-portal-2027.css');
    });

    test('company page templates do not hardcode colors', async () => {
        const pagesDir = path.join(__dirname, '..', 'views', 'client', 'pages');
        const files = fs.readdirSync(pagesDir).filter((name) => name.endsWith('.ejs'));
        files.forEach((name) => {
            const source = readPortalAsset(path.join(pagesDir, name));
            expect(source).not.toMatch(/style="[^"]*(?:color|background)\s*:\s*#/);
        });
    });
});


describe('agent portal shared modern design', () => {
    const agentWorkspace = { ...managerWorkspace, type: 'agent', isCompany: false, isAgent: true,
        portalLabel: 'بوابة الوكلاء', entityLabel: 'الوكيل', roleLabel: 'مدير الوكيل',
        permissions: { ...managerWorkspace.permissions, canRequestDeposit: false, canManageCustomers: true, canManageStaff: true } };
    test.each(['services', 'service_workbench', 'smart_transfer', 'transactions', 'finance', 'settings', 'security', 'support', 'customers', 'staff'])('renders %s with agent identity and permission-scoped navigation', async page => {
        const html = await renderWorkspacePage(page, { workspace: agentWorkspace, clientTheme: 'night',
            servicePage: { selectedService: 'vodafone', isolated: true },
            customers: [], pendingRequests: [], customerSummary: { total: 0, active: 0, positiveBalances: 0, totalDebt: 0 },
            staffSummary: { total: 0, active: 0, managers: 0, accountants: 0, monthOperations: 0 }, staffFilters: { search: '', role: '', status: '' } });
        expect(html).toContain('data-portal="agent"');
        expect(html).toContain('data-theme="night"');
        expect(html).toContain('class="cm-header"');
        expect(html).toContain('/css/portal-shell/modern.css');
        expect(html).not.toContain('href="/agent-portal/finance/customer-debts"');
        expect(html).not.toContain('href="/client/company/deposits"');
        expect(html).toContain('data-company-bell');
        if (page === 'service_workbench') {
            expect(html).toContain('cm-transfer-summary');
            expect((html.match(/id="businessTransferForm"/g) || []).length).toBe(1);
        }
        if (page === 'staff') expect(html).toContain('action="/agent-portal/agent/staff/add"');
    });
    test('employee presentation does not expose balances or customer administration', async () => {
        const workspace = { ...agentWorkspace, persona: 'employee', forceToday: true, permissions: { employee: true, canTransfer: true } };
        const html = await renderWorkspacePage('services', { workspace });
        expect(html).toContain('cm-service-grid');
        expect(html).not.toContain('cm-wallet-amount');
        expect(html).not.toContain('href="/agent-portal/customers"');
        expect(html).not.toContain('href="/agent-portal/finance/customer-debts"');
    });
});
