'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const VIEW_PATH = path.join(__dirname, '..', 'views', 'transactions.ejs');
const tableStyles = fs.readFileSync(path.join(__dirname, '..', 'public/css/admin-transactions.css'), 'utf8');

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
    totalTxs: 0,
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
    test('monitor page shows last receipt, capped attempts and preserves review filters across pages', () => {
        const tx = {
            _id: '507f1f77bcf86cd799439011', customId: 'ATT-REVIEW', status: 'processing',
            amount: 100, createdAt: new Date(), updatedAt: new Date(), transferType: 'vodafone',
            providerReviewAvailable: true, providerMonitorLabel: 'المزود يؤكد النجاح',
            apiResultData: { providerMonitorState: 'paid', providerMonitorAttempts: 2, providerMonitorStopped: true,
                providerReportedStatus: '<script>unsafe</script>', providerReportedReference: '0121****429', providerLastCheckedAt: new Date() }
        };
        const html = renderTransactions({
            transactions: [tx], operationWorkspace: true, providerReviewMode: true,
            providerReviewCounts: [{ _id: 'paid', count: 101 }], providerMonitorEnabled: true,
            totalTxs: 101, totalPages: 2, query: { providerReview: '1', providerState: 'paid' }
        });
        expect(html).toContain('عمليات API تحتاج مراجعة');
        expect(html).toContain('آخر استعلام:');
        expect(html).toContain('2 / 8');
        expect(html).toContain('providerReview=1&amp;providerState=paid');
        expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
        const statusMarkup = html.match(/data-provider-monitor-status>[\s\S]*?<\/div>/g).join('');
        expect(statusMarkup).not.toContain('<script>unsafe</script>');
        expect(html).not.toContain('data-ops-summary-strip="operations"');
        expect((html.match(/data-provider-monitor-status/g) || []).length).toBe(2);
    });
    test.each(['processing', 'completed'])('provider controls are consistent on desktop and mobile for %s', (status) => {
        const { canReviewProviderOperation } = require('../utils/providerPendingOperation');
        const tx = {
            _id: '507f1f77bcf86cd799439011', customId: 'ATT-API-TEST', status,
            amount: 100, costLYD: 20, transferType: 'vodafone', vodafoneNumber: '01000000000',
            createdAt: new Date(), updatedAt: new Date(), apiResultData: { providerTransactionId: '6103691' }
        };
        tx.providerReviewAvailable = canReviewProviderOperation(tx);
        const html = renderTransactions({ transactions: [tx], operationWorkspace: true });
        for (const action of ['check', 'paid', 'cancel']) {
            expect((html.match(new RegExp(`data-provider-row-action="${action}"`, 'g')) || []).length)
                .toBe(status === 'processing' ? 2 : 0);
        }
    });
    test('operations offers the full history and an optional date range', () => {
        const html = renderTransactions({
            operationWorkspace: true,
            fromDate: '',
            toDate: '',
            totalTxs: 125,
            totalPages: 2
        });

        expect(html).toContain('action="/transactions/operations"');
        expect(html).toContain('name="fromDate"');
        expect(html).toContain('name="toDate"');
        expect(html).toContain('href="/transactions/operations"');
        expect(html).toContain('125 عملية');
        expect(html).toContain('page=2');

        const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'adminTransactions.js'), 'utf8');
        expect(routeSource).toContain('if (!operationsWorkspace && fromDate === undefined && toDate === undefined)');
        expect(routeSource).toContain('if (fromDate || toDate)');
    });

    test('central ledger does not show the operations history filter', () => {
        expect(renderTransactions()).not.toContain('action="/transactions/operations"');
    });

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
                today: { egyptianEGP: 12400.5, libyanLYD: 2310.25, cashEGP: 10000.5, bankEGP: 2400, totalLYD: 2310.25 },
                todayDepositsTotal: 900,
                todayExecutorDepositsTotal: 745.25,
                activeExecutors: [
                    { id: 'e1', name: 'منفذ كاش', balance: 2500.5, cashBalance:2500.5, bankBalance:0, activityCount:4, completedToday: 4, depositsToday: 320.5 },
                    { id: 'e2', name: 'منفذ سريع', balance: 128450.75, cashBalance:128450.75, bankBalance:0, activityCount:0, completedToday: 0, depositsToday: 0 }
                ],
                companies: [
                    { id: 'c1', name: 'شركة النور', balance: 88.5, activityCount:7, completedToday: 7, depositsToday: 900 },
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

        const totals = html.slice(html.indexOf('class="ow-totals"'),html.indexOf('class="ow-workspace"'));
        for(const label of ['إجمالي اليوم بالمصري','الكاش','البنكي','مقابل شغل اليوم بالليبي','إيداعات الشركات اليوم','إيداعات المنفذين اليوم','مقارنة عدد العمليات']) expect(totals).toContain(label);
        for(const amount of ['12,400.50','10,000.50','2,400.00','2,310.25','900.00','745.25','1,234,567.89','320.50']) expect(totals).toContain(amount);
        expect(totals).toContain('EGP');expect(totals).toContain('LYD');
        const companies = html.slice(html.indexOf('class="ow-companies"'),html.indexOf('class="ow-search"'));
        expect(companies).toContain('href="/company/c1"');expect(companies).toContain('href="/company/c2"');
        expect(companies).toContain('88.50');expect(companies).toContain('-12.00');expect(companies).toContain('ow-negative');
        expect(companies).toContain('المكتملة اليوم <b>7</b>');
        expect(companies.indexOf('شركة النور')).toBeLessThan(companies.indexOf('شركة الأمل'));
        const executors = html.slice(html.indexOf('class="ow-executors"'),html.indexOf('</section>',html.indexOf('class="ow-executors"')));
        expect(executors).toContain('/transactions/operations?executorId=e1');expect(executors).toContain('href="/executor/e2"');
        for(const amount of ['2,500.50','128,450.75','0.00']) expect(executors).toContain(amount);
        expect(executors).toContain('رصيد الكاش');expect(executors).toContain('رصيد البنك');
        expect(executors).toContain('المنفذة اليوم <b>4</b>');expect(executors).toContain('المنفذة اليوم <b>0</b>');
        expect(executors.indexOf('منفذ كاش')).toBeLessThan(executors.indexOf('<details>'));
        expect(executors.indexOf('<details>')).toBeLessThan(executors.indexOf('منفذ سريع'));
        expect(html.indexOf('class="ow-dashboard"')).toBeLessThan(html.indexOf('id="transactionsTable"'));
        expect(html).toContain('@media(max-width:760px)');expect(html).toContain('@media(max-width:440px)');

    });

    test('renders a cancelled operation in the same operations table with a red ملغاة badge', () => {
        const html = renderTransactions({
            operationWorkspace: true,
            transactions: [
                {
                    _id: { toString: () => '507f1f77bcf86cd799439011' },
                    customId: 'ATT-DONE',
                    status: 'completed',
                    amount: 100,
                    createdAt: new Date('2026-09-21T12:00:00Z'),
                    companyName: 'شركة النور',
                    employeeName: 'خالد',
                    vodafoneNumber: '01000000001',
                    transferType: 'vodafone',
                    costLYD: 18,
                    exchangeRate: 5
                },
                {
                    _id: { toString: () => '507f1f77bcf86cd799439012' },
                    customId: 'ATT-CANCEL',
                    status: 'cancelled_by_admin',
                    amount: 80,
                    createdAt: new Date('2026-09-21T11:00:00Z'),
                    companyName: 'شركة الأمل',
                    employeeName: 'سالم',
                    vodafoneNumber: '01000000002',
                    transferType: 'vodafone',
                    costLYD: 15,
                    exchangeRate: 5
                }
            ]
        });

        const table = html.slice(html.indexOf('id="transactionsTable"'), html.indexOf('id="mobileCardsContainer"'));
        expect(table.indexOf('ATT-DONE')).toBeGreaterThan(-1);
        expect(table.indexOf('ATT-CANCEL')).toBeGreaterThan(table.indexOf('ATT-DONE'));
        expect(table).toContain('ملغاة');
        expect(table).toContain('st-fail');
        expect(table).not.toContain('العمليات الملغاة');
        expect(html).toContain('class="m-0 js-transaction-action"');
    });

    test('shows تحويل بنكي under the account number for bank transfers only', () => {
        const html = renderTransactions({
            operationWorkspace: true,
            transactions: [
                {
                    _id: { toString: () => '507f1f77bcf86cd799439021' },
                    customId: 'ATT-BANK',
                    status: 'pending',
                    amount: 2500,
                    createdAt: new Date('2026-09-21T12:00:00Z'),
                    companyName: 'شركة النور',
                    employeeName: 'خالد',
                    accountNumber: 'EG380019000500000000263180002',
                    transferType: 'bank_account',
                    costLYD: 400,
                    exchangeRate: 6.25
                },
                {
                    _id: { toString: () => '507f1f77bcf86cd799439022' },
                    customId: 'ATT-CASH',
                    status: 'pending',
                    amount: 300,
                    createdAt: new Date('2026-09-21T11:00:00Z'),
                    companyName: 'شركة الأمل',
                    employeeName: 'سالم',
                    vodafoneNumber: '01011111111',
                    transferType: 'vodafone',
                    costLYD: 48,
                    exchangeRate: 6.25
                }
            ]
        });

        const table = html.slice(html.indexOf('id="transactionsTable"'), html.indexOf('id="mobileCardsContainer"'));
        const bankRow = table.slice(table.indexOf('ATT-BANK'), table.indexOf('ATT-CASH'));
        const cashRow = table.slice(table.indexOf('ATT-CASH'));
        expect(bankRow).toContain('EG380019000500000000263180002');
        expect(bankRow).toContain('تحويل بنكي');
        expect(bankRow).not.toContain('فودافون');
        expect(bankRow).not.toContain('كاش');
        expect(cashRow).toContain('01011111111');
        expect(cashRow).toContain('فودافون');
        expect(cashRow).not.toContain('تحويل بنكي');

        const cards = html.slice(html.indexOf('id="mobileCardsContainer"'), html.indexOf('id="txModal"'));
        const mobileBank = cards.slice(cards.indexOf('ATT-BANK'), cards.indexOf('ATT-CASH'));
        const mobileCash = cards.slice(cards.indexOf('ATT-CASH'));
        expect(mobileBank).toContain('تحويل بنكي');
        expect(mobileCash).not.toContain('تحويل بنكي');
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

        expect(routeSource).toMatch(/const listSortMode = operationsWorkspace \? 'operations' : 'ledger'/);
        expect(routeSource).toMatch(/operationsWorkspace && !providerReviewMode && !listRefresh\s*\?\s*loadOperationsSummaryStrip\(\{ Transaction, ClientCompany, ExecutorGroup, source: req \}\)/);
        expect(routeSource).toMatch(/\(operationsWorkspace \|\| listRefresh\)\s*\?\s*Promise\.resolve\(null\)\s*:\s*loadCentralLedgerOverview/);
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


describe('lightweight transaction refresh', () => {
    const fragmentPath = path.join(__dirname, '..', 'views/partials/transaction_refresh.ejs');
    const renderFragment = overrides => ejs.render(fs.readFileSync(fragmentPath, 'utf8'), { ...baseLocals, ...overrides }, { filename: fragmentPath });
    test.each(['pending', 'processing', 'accepted', 'completed', 'rejected', 'deposit', 'deduction'])('keeps the same table, mobile controls and snapshots for %s', status => {
        const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-24T12:00:00Z'));
        try {
            const data = { transactions: [{ _id: '507f1f77bcf86cd799439011', customId: 'ATT-TEST', status, amount: 100, costLYD: 16, transferType: 'vodafone', createdAt: new Date('2026-10-24T11:00:00Z'), balanceAdjustment: { reversible: true }, customerNotes: '</script><script>unsafe</script>' }] };
            const full = renderTransactions(data), fragment = renderFragment(data);
            const section = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
            expect(section(fragment, '<tbody>', '</tbody>')).toBe(section(full, '<tbody>', '</tbody>'));
            expect(section(fragment, 'id="mobileTransactionRows"', 'id="transactionPagination"')).toBe(section(full, 'id="mobileTransactionRows"', 'id="transactionPagination"'));
            expect(fragment).not.toMatch(/<html|<head|<style|src="/);
            const snapshots = fragment.match(/id="transactionRowsData">([\s\S]*?)<\/script>/)[1];
            expect(snapshots).not.toContain('<script>');
            expect(JSON.parse(snapshots)[data.transactions[0]._id].customerNotes).toBe(data.transactions[0].customerNotes);
        } finally { clock.mockRestore(); }
    });
    test('keeps provider resolution controls and review filters in partial responses', () => {
        const html = renderFragment({ operationWorkspace: true, providerReviewMode: true, providerMonitorEnabled: true, providerReviewCounts: [{ _id: 'paid', count: 1 }], query: { providerState: 'paid' }, totalPages: 2, totalTxs: 101, transactions: [{ _id: '507f1f77bcf86cd799439011', status: 'processing', transferType: 'vodafone', amount: 10, createdAt: new Date(), providerReviewAvailable: true, apiResultData: { providerMonitorState: 'paid' } }] });
        expect(html).toContain('id="providerReviewSummary"');
        expect(html).toContain('providerReview=1&amp;providerState=paid');
        expect(html).toContain('data-provider-row-action="check"');
        expect(html).toContain('data-provider-row-action="paid"');
        expect(html).toContain('data-provider-row-action="cancel"');
    });
});
