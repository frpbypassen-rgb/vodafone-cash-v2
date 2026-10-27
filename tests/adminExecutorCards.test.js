'use strict';
const path = require('path');
const ejs = require('ejs');
const render = (bot, options = {}) => ejs.renderFile(
    path.join(__dirname, '../views/partials/admin_executor_card.ejs'),
    {
        bot: { _id: 'demo', name: 'منفذ تجريبي', status: 'active', serviceKey: 'vodafone', serviceLabel: 'محافظ كاش', balance: -50, ...bot },
        archived: false, isMaster: true, executorServiceOptions: [], ...options
    }
);

test('API cards distinguish a missing provider snapshot from the local wallet balance', async () => {
    const missing = await render({ isApiBot: true, balance: 999999 });
    expect(missing).toContain('لا يوجد رصيد محفوظ من المزود');
    expect(missing).not.toContain('999,999.00');
    const snapshot = await render({ isApiBot: true, liveApiServiceCredit: 1234.5, balance: 999999 });
    expect(snapshot).toContain('1,234.50');
    expect(snapshot).toContain('آخر رصيد محفوظ لدى المزود');
    expect(snapshot).not.toContain('999,999.00');
});

test('multi-service cards preserve allocated pool totals and separate private service balances', async () => {
    const html = await render({ multiService: true, serviceBalances: [
        { appliesPoolModel: true, totalLabel: 'إجمالي الكاش', totalBalance: 4200, privateBalance: 111 },
        { appliesPoolModel: false, singleLabel: 'البنك', privateBalance: -1700, totalBalance: 222 }
    ] });
    expect(html).toContain('4,200.00');
    expect(html).toContain('-1,700.00');
    expect(html).not.toContain('111.00');
    expect(html).not.toContain('222.00');
});

test('restricted viewers and archived cards cannot expose editable service or archive controls', async () => {
    const restricted = await render({}, { isMaster: false });
    expect(restricted).not.toContain('<form');
    expect(restricted).not.toContain('onclick="archiveExecutor');
    expect(restricted).not.toContain('/admin/accounts/executor/');
    const archived = await render({ archiveReason: 'اختبار' }, { archived: true });
    expect(archived).toContain('عرض العمليات المحفوظة');
    expect(archived).not.toContain('<form');
    expect(archived).not.toContain('onclick="archiveExecutor');
    expect(archived).not.toContain('#settlementForm');
});

test('executor names and providers remain escaped in card content and filter attributes', async () => {
    const html = await render({ name: '<img src=x onerror=alert(1)>', isApiBot: true, apiProviderKey: '"><script>alert(1)</script>' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;img');
});
