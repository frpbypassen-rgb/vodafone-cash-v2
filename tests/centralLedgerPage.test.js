'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const VIEW_PATH = path.join(__dirname, '..', 'views', 'transactions.ejs');

const baseLocals = {
    adminName: 'مدير الاختبار',
    role: 'admin',
    csrfToken: 'test-csrf',
    query: {},
    transactions: [],
    executorGroups: [],
    executorBots: [],
    allGroupsMap: {},
    allBotsMap: {},
    executorDisplayByTransaction: {},
    currentPage: 1,
    totalPages: 1,
    search: '',
    statusFilter: '',
    fromDate: '2026-09-01',
    toDate: '2026-09-30',
    filterType: '',
    dailyTotals: { transfersEGP: 10, transfersLYD: 2, depositsEGP: 5, deductionsEGP: 1 },
    periodStats: {
        today: { count: 4, amountEGP: 1200 },
        week: { count: 18, amountEGP: 5400 },
        month: { count: 41, amountEGP: 12800 }
    },
    activeClientCompanies: [{ id: 'c1', name: 'شركة النور', balance: 88.5, accountCode: 'C-01' }],
    fundedExecutorCompanies: [{ id: 'e1', name: 'منفذ كاش', balance: 250, isManager: false, balanceSource: 'internal' }],
    executorBalanceGroups: [],
    executorId: '',
    operationWorkspace: false
};

const renderTransactions = (overrides = {}) => ejs.render(
    fs.readFileSync(VIEW_PATH, 'utf8'),
    { ...baseLocals, ...overrides },
    { filename: VIEW_PATH }
);

describe('central ledger page layout', () => {
    test('replaces deposit/discount KPI cards with compact successful-ops stats and company columns', () => {
        const html = renderTransactions();

        expect(html).toContain('السجل المركزي والمراقبة');
        expect(html).toContain('كشوفات العملاء');
        expect(html).toContain('إيداعات الشركات');
        expect(html).toContain('إيداعات التنفيذ');
        expect(html).toContain('mb-4 tx-page-title');
        expect(html).toContain('إجمالي العمليات الناجحة اليوم');
        expect(html).toContain('إجمالي الأسبوع');
        expect(html).toContain('إجمالي الشهر');
        expect(html).toContain('الشركات النشطة');
        expect(html).toContain('أرصدة الشركة');
        expect(html).toContain('الشركات المنفذة');
        expect(html).toContain('شركة النور');
        expect(html).toContain('منفذ كاش');
        expect(html).not.toContain('تصفية سريعة');
        expect(html).not.toContain('id="transactionsFilterForm"');
        expect(html).not.toContain('id="mobileTransactionsFilterForm"');
        expect(html).not.toContain('id="searchInput"');
        expect(html).toContain('id="transactionsTable"');
        expect(html.indexOf('ledger-stats-bar')).toBeGreaterThan(-1);
        expect(html.indexOf('ledger-stats-bar')).toBeLessThan(html.indexOf('الشركات النشطة'));
        expect(html.indexOf('ledger-overview-cols')).toBeLessThan(html.indexOf('id="transactionsTable"'));

        expect(html).not.toContain('إجمالي تحويلات اليوم (مكتملة)');
        expect(html).not.toContain('إجمالي إيداعات اليوم');
        expect(html).not.toContain('إجمالي خصومات اليوم');
        expect(html).toContain('href="/transactions/live"');
        expect(html).toContain('المراقبة الحية');
        expect(html).not.toContain('لا توجد شركات نشطة حالياً');
        expect(html).not.toContain('لا توجد شركة منفذة برصيد متاح حالياً');
        expect(html).not.toContain('data-ops-summary-strip');
        expect(html).not.toContain('إجمالي الإيداعات اليوم');
        expect(html).not.toContain('إيداعات المنفذين');
        expect(html).not.toContain('data-ops-executor-deposits');
        expect(html).not.toContain('المنفذين النشطين');
        expect(html).not.toContain('data-ops-micro');
    });

    test('shows the empty header copy only when company and executor lists are empty', () => {
        const html = renderTransactions({
            activeClientCompanies: [],
            fundedExecutorCompanies: []
        });

        expect(html).toContain('لا توجد شركات نشطة حالياً');
        expect(html).toContain('لا توجد شركة منفذة برصيد متاح حالياً');
        expect(html).not.toContain('شركة النور');
        expect(html).not.toContain('منفذ كاش');
    });

    test('operations workspace shows the compact summary strip and the table without the old header', () => {
        const html = renderTransactions({
            operationWorkspace: true,
            operationsSummary: {
                today: { egyptianEGP: 12400.5, libyanLYD: 2310.25 },
                todayDepositsTotal: 900,
                todayExecutorDepositsTotal: 745.25,
                activeExecutors: [
                    { id: 'e1', name: 'منفذ كاش', balance: 2500.5, completedToday: 4, depositsToday: 320.5 },
                    { id: 'e2', name: 'منفذ سريع', balance: 128450.75, completedToday: 0, depositsToday: 0 }
                ],
                companies: [
                    { id: 'c1', name: 'شركة النور', balance: 88.5, completedToday: 7, depositsToday: 900 },
                    { id: 'c2', name: 'شركة الأمل', balance: -12, completedToday: 0, depositsToday: 1234567.89 }
                ]
            },
            transactions: [{
                _id: { toString: () => '507f1f77bcf86cd799439011' },
                customId: 'ATT-2609-11988',
                status: 'pending',
                amount: 100,
                createdAt: new Date('2026-09-21T14:14:00Z'),
                companyName: 'شركة الأهرام للاتصالات وتقنية المعلومات',
                employeeName: 'خالد الزواوي',
                vodafoneNumber: '01000000000',
                transferType: 'vodafone',
                costLYD: 18.69,
                exchangeRate: 5.35
            }]
        });

        expect(html).toContain('id="transactionsTable"');
        expect(html).toContain('رقم العملية');
        expect(html).toContain('ATT-2609-11988');
        expect(html).toContain('data-bs-toggle="dropdown">توجيه</button>');
        expect(html).not.toContain('العمليات والتوجيه');
        expect(html).not.toContain('كشوفات العملاء');
        expect(html).not.toContain('حالات العمليات');
        expect(html).not.toContain('ملغية إداريًا');
        expect(html).not.toContain('mb-4 tx-page-title');
        expect(html).not.toContain('id="transactionsFilterForm"');
        expect(html).not.toContain('id="mobileTransactionsFilterForm"');
        expect(html).not.toContain('id="searchInput"');
        expect(html).not.toContain('id="mobileSearchInput"');
        expect(html).not.toContain('id="statusFilter"');
        expect(html).not.toContain('class="mobile-filter-card');
        expect(html).not.toContain("window.location.replace(`/transactions/operations?");

        expect(html).not.toContain('إجمالي تحويلات اليوم (مكتملة)');
        expect(html).not.toContain('إجمالي إيداعات اليوم');
        expect(html).not.toContain('إجمالي خصومات اليوم');
        expect(html).not.toContain('تحويلات اليوم');
        expect(html).not.toContain('خصومات اليوم');
        expect(html).not.toContain('المنفذون الجاهزون');
        expect(html).not.toContain('executor-balance-panel');
        expect(html).not.toContain('mobile-summary-strip');
        expect(html).not.toContain('إجمالي العمليات الناجحة اليوم');
        expect(html).not.toContain('الشركات النشطة');
        expect(html).not.toContain('class="ledger-stats-bar');

        expect(html).toContain('data-ops-summary-strip="operations"');
        expect(html).toContain('مصري');
        expect(html).toContain('ليبي');
        expect(html).toContain('إجمالي الإيداعات اليوم');
        expect(html).toContain('إيداعات المنفذين');
        expect(html).toContain('المنفذين النشطين');
        expect(html).toContain('إجمالي الرصيد معهم');
        expect(html).toContain('data-ops-egyptian="12400.5"');
        expect(html).toContain('data-ops-libyan="2310.25"');
        expect(html).toContain('data-ops-deposits="900"');
        expect(html).toContain('data-ops-executor-deposits="745.25"');
        expect(html).toContain('745.25');
        const leftCluster = html.slice(html.indexOf('class="ops-summary-left"'), html.indexOf('class="ops-summary-right"'));
        const executorDepositsBox = leftCluster.slice(leftCluster.indexOf('data-ops-executor-deposits-total'), leftCluster.indexOf('data-ops-today-totals'));
        expect(executorDepositsBox).toContain('إيداعات المنفذين');
        expect(executorDepositsBox).toContain('data-ops-executor-deposits="745.25"');
        expect(executorDepositsBox).toContain('EGP');
        expect(leftCluster).toContain('إجمالي الإيداعات اليوم');
        expect(leftCluster).toContain('data-ops-deposits="900"');
        expect(leftCluster).toContain('LYD');
        expect(leftCluster.indexOf('إيداعات المنفذين')).toBeLessThan(leftCluster.indexOf('إجمالي اليوم'));
        expect(leftCluster.indexOf('إجمالي اليوم')).toBeLessThan(leftCluster.indexOf('إجمالي الإيداعات اليوم'));
        expect(html).toContain('منفذ كاش');
        expect(html).toContain('2,500.50');
        expect(html).toContain('128,450.75');
        expect(html).toContain('data-ops-company="c1"');
        expect(html).toContain('شركة النور');
        expect(html).toContain('data-ops-micro="completed"');
        expect(html).toContain('عمليات اليوم');
        expect(html).toContain('data-ops-completed="7"');
        expect(html).toContain('data-ops-micro="deposit"');
        expect(html).toContain('إيداع اليوم');
        expect(html).toContain('data-ops-company-deposit="1234567.89"');
        expect(html).toContain('1,234,567.89');
        expect(html).toMatch(/\.ops-uniform-card\s*\{[^}]*width:\s*210px[^}]*height:\s*152px/);
        expect(html).toMatch(/\.ops-exec-card\s*\{[^}]*width:\s*160px[^}]*height:\s*100px/);
        expect(html).toMatch(/\.ops-micro-stack\s*\{[^}]*flex-direction:\s*column/);
        expect(html).toMatch(/\.ops-micro\s*\{[^}]*width:\s*100%/);
        expect(html).toMatch(/\.ops-mini-card\s*\{[^}]*padding:\s*7px 10px/);
        expect(html).toContain('class="ops-exec-card"');
        expect(html).not.toContain('ops-exec-card ops-uniform-card');
        expect(html).toContain('ops-company-card ops-uniform-card');
        const firstExecutor = html.slice(html.indexOf('data-ops-executor="e1"'), html.indexOf('data-ops-executor="e2"'));
        expect(firstExecutor).toContain('ops-micro-stack');
        expect(firstExecutor).toContain('عمليات اليوم');
        expect(firstExecutor).toContain('إيداع اليوم');
        expect(firstExecutor).toContain('data-ops-completed="4"');
        expect(firstExecutor).toContain('data-ops-executor-deposit="320.5"');
        expect(firstExecutor).toContain('320.50');
        expect(firstExecutor.indexOf('ops-exec-value')).toBeLessThan(firstExecutor.indexOf('data-ops-micro="completed"'));
        expect(firstExecutor.indexOf('data-ops-micro="completed"')).toBeLessThan(firstExecutor.indexOf('data-ops-micro="deposit"'));
        const secondExecutor = html.slice(html.indexOf('data-ops-executor="e2"'), html.indexOf('data-ops-company="c1"'));
        expect(secondExecutor).toContain('data-ops-completed="0"');
        expect(secondExecutor).toContain('data-ops-executor-deposit="0"');
        expect(html).not.toContain('ops-company-cluster');
        const firstCompany = html.slice(html.indexOf('data-ops-company="c1"'), html.indexOf('data-ops-company="c2"'));
        expect(firstCompany).toContain('ops-micro-stack');
        expect(firstCompany.indexOf('ops-company-balance')).toBeLessThan(firstCompany.indexOf('data-ops-micro="completed"'));
        expect(firstCompany.indexOf('data-ops-micro="completed"')).toBeLessThan(firstCompany.indexOf('data-ops-micro="deposit"'));
        expect(html.indexOf('data-ops-summary-strip')).toBeLessThan(html.indexOf('id="transactionsTable"'));
        expect(html.indexOf('ops-summary-left')).toBeLessThan(html.indexOf('ops-summary-right'));
    });

    test('rebuilds the comprehensive operation details modal with tabs and smart header chrome', () => {
        const html = renderTransactions();

        expect(html).toContain('id="txModal"');
        expect(html).toContain('id="od-copy-id"');
        expect(html).toContain('id="od-print-invoice"');
        expect(html).toContain('onclick="printInvoice()"');
        expect(html).toContain('تفاصيل العملية الشاملة');
        expect(html).toContain('data-od-tab="summary"');
        expect(html).toContain('data-od-tab="parties"');
        expect(html).toContain('data-od-tab="finance"');
        expect(html).toContain('data-od-tab="proofs"');
        expect(html).toContain('data-od-tab="timeline"');
        expect(html).toContain('data-od-tab="notes"');
        expect(html).toContain('الملخص');
        expect(html).toContain('الأطراف');
        expect(html).toContain('المالية');
        expect(html).toContain('الإثباتات');
        expect(html).toContain('الخط الزمني');
        expect(html).toContain('الملاحظات');
        expect(html).toContain('/js/admin-operation-details.js');
        expect(html).toContain('id="transactionsTable"');
        expect(html).toContain('السجل المركزي والمراقبة');
        expect(html).not.toContain('id="m_detail_panel"');
        expect(html).not.toContain('تتبع دورة حياة التنفيذ');
    });

    test('ledger table and period-stat queries use adminAccountScope and keep SubAccount privacy', () => {
        const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'adminTransactions.js'), 'utf8');
        const overviewSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'centralLedgerOverviewService.js'), 'utf8');
        const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

        expect(routeSource).toMatch(/operationsWorkspace\s*\?\s*loadOperationsSummaryStrip\(\{ Transaction, ClientCompany, ExecutorGroup, source: req \}\)/);
        expect(routeSource).toMatch(/operationsWorkspace\s*\?\s*Promise\.resolve\(null\)\s*:\s*loadCentralLedgerOverview/);
        expect(routeSource).toMatch(/const transactionLedgerBaseQuery = \(source = null\) => applyAdminTxPrivacy\(\{[\s\S]*\.\.\.adminAccountScope\(source\),/);
        expect(routeSource).not.toMatch(/isSubAccountTx: \{ \$ne: true \}/);
        expect(routeSource).toMatch(/adminVisibleTransactionQuery\(adminAccountScope\(req\)/);
        expect(routeSource).toMatch(/ExecutorGroup\.find\(\{ \.\.\.adminAccountScope\(req\), status: 'active', isManagerBot: \{ \$ne: true \} \}\)/);
        expect(overviewSource).toMatch(/applyAdminTxPrivacy\(\{[\s\S]*\.\.\.adminAccountScope\(source\),[\s\S]*status: SUCCESS_STATUS/);
        expect(overviewSource).not.toMatch(/\.\.\.tenantScope\(source\)/);
        expect(appSource.indexOf("require('./routes/liveOperations')"))
            .toBeLessThan(appSource.indexOf("require('./routes/adminTransactions')"));
    });
});
