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

test('renders centered account cards and all-date search, escaping account names', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/operations_workspace_summary.ejs'), {
        opsSummary: { counts: {}, todayDepositsTotal: 0, todayExecutorDepositsTotal: 0 },
        opsToday: {}, opsCompanies: [{ id: 'c', name: '<script>bad</script>', balance: -123456789, completedToday: 4 }],
        opsExecutors: [{ id: 'busy', name: 'Busy', activityCount: 1, balance: 9 }, { id: 'idle', name: 'Idle', activityCount: 0, balance: -9 }],
        formatMoney: value => String(value || 0), formatCount: value => String(value || 0), search: ''
    });
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).toContain('name="fromDate" value=""');
    expect(html).toContain('name="toDate" value=""');
    expect(html.indexOf('Busy')).toBeLessThan(html.indexOf('<details>'));
    expect(html.indexOf('Idle')).toBeGreaterThan(html.indexOf('<details>'));
    expect(html).toContain('ow-negative');
});
