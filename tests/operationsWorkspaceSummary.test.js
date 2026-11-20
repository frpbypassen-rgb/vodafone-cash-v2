'use strict';
jest.mock('../services/operationsSummaryStripService', () => ({ loadOperationsSummaryStrip: jest.fn() }));
jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));
const base = require('../services/operationsSummaryStripService');
const { loadOperationsSummaryStrip } = require('../services/operationsWorkspaceSummaryService');
const ejs = require('ejs');
const path = require('path');
const fs = require('fs');

test('passes page-local summary variables explicitly into the included template', () => {
    const filename = path.join(__dirname, '../views/transactions.ejs');
    const source = fs.readFileSync(filename, 'utf8');
    const include = source.match(/<%- include\('partials\/operations_workspace_summary'[^\n]+/)[0];
    const html = ejs.render(`<% const opsSummary = { counts: {} }; const opsToday = {}; const opsCompanies = []; const opsExecutors = []; const formatMoney = value => String(value || 0); const formatCount = formatMoney; const search = ''; %>${include}`, {}, { filename });
    expect(html).toContain('بحث شامل');
    expect(html).toContain('لا توجد شركات نشطة.');
    expect(html).toContain('لا يوجد منفذون للعرض.');
});

test('adds independent period counts and activity without changing balances', async () => {
    base.loadOperationsSummaryStrip.mockResolvedValue({ companies: [{ id: 'c1', balance: -12 }], activeExecutors: [{ id: 'e1', balance: 200 }, { id: 'e2', balance: 1 }] });
    const Transaction = { aggregate: jest.fn().mockResolvedValueOnce([{ companies: [{ _id: 'c1', count: 3 }], executors: [{ _id: 'e1', count: 2 }] }]).mockResolvedValueOnce([{ today: [{ count: 5 }], week: [{ count: 20 }], cancelled: [{ count: 1 }] }]) };
    const result = await loadOperationsSummaryStrip({ Transaction, source: {}, now: new Date('2026-10-25T12:00:00Z') });
    expect(result.companies[0]).toMatchObject({ balance: -12, activityCount: 3 });
    expect(result.activeExecutors[1]).toMatchObject({ balance: 1, activityCount: 0 });
    expect(result.counts).toEqual({ today: 5, cancelled: 1, week: 20, month: 0, total: 0 });
    expect(Transaction.aggregate.mock.calls[1][0][1].$facet.cancelled[0].$match.status).toBe('cancelled_by_admin');
});

test('renders visible summary cards with account balances, deposits and links', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/operations_workspace_summary.ejs'), {
        opsSummary: { counts: {}, todayDepositsTotal: 0, todayExecutorDepositsTotal: 0 },
        opsToday: {}, opsCompanies: [{ id: 'c', name: '<شركة>', balance: -123456789, completedToday: 4, depositsToday: 24 }],
        opsExecutors: [{ id: 'idle', name: 'Idle', activityCount: 0 }, { id: 'busy', name: 'Busy', activityCount: 1, cashBalance: 9, bankBalance: -5, depositsToday: 150 }],
        formatMoney: value => String(value || 0), formatCount: value => String(value || 0), search: ''
    });
    expect(html).toContain('&lt;شركة&gt;');
    expect(html).toContain('name="fromDate" value=""');
    expect(html).toContain('name="toDate" value=""');
    expect(html).toMatch(/<section class="ow-executors"[^>]*>[\s\S]*?Busy[\s\S]*?Idle[\s\S]*?<\/section>/);
    expect(html).not.toMatch(/<details class="ow-(breakdown|companies|executors)"/);
    expect(html.match(/class="ow-total"/g)).toHaveLength(4);
    expect(html.match(/class="ow-stat(?: |")/g)).toHaveLength(7);
    expect(html).toMatch(/href="\/company\/c"[\s\S]*?ow-negative[\s\S]*?-123456789[\s\S]*?إيداع اليوم[\s\S]*?24 <small>LYD<\/small>/);
    expect(html).toMatch(/href="\/transactions\/operations\?executorId=busy&amp;fromDate=&amp;toDate="[\s\S]*?رصيد البنك[\s\S]*?ow-negative[\s\S]*?-5 <small>EGP<\/small>[\s\S]*?150 <small>EGP<\/small>/);
    expect(html).toMatch(/href="\/executor\/idle"[\s\S]*?غير متاح/);
});
