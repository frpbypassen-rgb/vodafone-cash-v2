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
    });

    test('keeps the operations workspace KPI cards unchanged', () => {
        const html = renderTransactions({ operationWorkspace: true });

        expect(html).toContain('العمليات والتوجيه');
        expect(html).toContain('إجمالي تحويلات اليوم (مكتملة)');
        expect(html).toContain('إجمالي إيداعات اليوم');
        expect(html).toContain('إجمالي خصومات اليوم');
        expect(html).not.toContain('إجمالي العمليات الناجحة اليوم');
        expect(html).not.toContain('الشركات النشطة');
        expect(html).toContain('البحث الشامل');
        expect(html).toContain('id="transactionsFilterForm"');
        expect(html).toContain('id="transactionsTable"');
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
});
