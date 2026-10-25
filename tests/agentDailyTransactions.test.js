'use strict';
jest.mock('../models/SubAccount', () => ({ find: jest.fn(() => ({ distinct: async () => [] })) }));
const { buildTransactionFilter } = require('../services/portalWorkspace/transactions');
const {
    renderAgentPage,
    renderWorkspacePage,
    buildAgentWorkspace,
} = require('./helpers/agentPortalFixtures');

afterEach(() => jest.useRealTimers());
test.each([
    ['2026-10-25T21:59:59.999Z', '2026-10-24T22:00:00.000Z', '2026-10-25T21:59:59.999Z'],
    ['2026-10-25T22:00:00.000Z', '2026-10-25T22:00:00.000Z', '2026-10-26T21:59:59.999Z'],
])('daily scope uses Libya midnight at %s and ignores history/date overrides', async (now, start, end) => {
    jest.useFakeTimers().setSystemTime(new Date(now));
    const result = await buildTransactionFilter(
        buildAgentWorkspace('owner'),
        {
            history: 'all',
            from: '2020-01-01',
            to: '2030-12-31',
            month: '2021-01',
            period: 'week',
        },
        { forceToday: true }
    );
    expect(result.includeAllHistory).toBe(false);
    expect(result.filter.$and).toContainEqual({ createdAt: { $gte: new Date(start), $lte: new Date(end) } });
});

test('company history retains its original date behavior', async () => {
    const result = await buildTransactionFilter(
        { isCompany: true, entity: { _id: 'company-a' }, permissions: {} },
        { history: 'all' }
    );
    expect(result.includeAllHistory).toBe(true);
    expect(result.filter).toEqual({ companyId: 'company-a' });
});

const transaction = {
    _id: '64b000000000000000000001',
    customId: 'ATT-TEST-001',
    status: 'completed',
    transferType: 'vodafone',
    createdAt: new Date(),
    amount: 1000,
    costLYD: 200,
    accountName: '<script>bad()</script>',
    vodafoneNumber: '01012345678',
    receiptImages: [{ url: '/client/proxy/image/64b000000000000000000001/0' }],
};
test('agency daily cards expose protected image sharing and escape recipient names', async () => {
    const html = await renderAgentPage('transactions', 'owner', { transactions: [transaction], total: 1 });
    expect(html).toContain('data-agent-daily-list');
    expect(html).toContain('data-agent-share-receipt');
    expect(html).toContain('/agent-portal/proxy/image/64b000000000000000000001/0');
    expect(html).not.toContain('name="from"');
    expect(html).not.toContain('name="to"');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>bad()</script>');
});

test('staff cards hide costs and pending operations have no share button', async () => {
    const html = await renderAgentPage('transactions', 'employee', {
        transactions: [{ ...transaction, status: 'pending', receiptImages: [], hasProof: false }],
    });
    const card = html.match(/<article class="agent-daily-card"[\s\S]*?<\/article>/)[0];
    expect(card).not.toContain('data-agent-share-receipt');
    expect(card).not.toContain('LYD');
    expect(card).toContain('بانتظار صورة العملية');
});

test('company page does not acquire agency cards, styles or share entrypoint', async () => {
    const html = await renderWorkspacePage('transactions', { transactions: [transaction], total: 1 });
    expect(html).not.toContain('data-agent-daily-list');
    expect(html).not.toContain('data-agent-share-receipt');
    expect(html).not.toContain('/css/agent-portal/');
    expect(html).toContain('name="from"');
});
