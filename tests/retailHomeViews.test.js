'use strict';
const ejs = require('ejs');
const path = require('path');
const view = path.join(__dirname, '../views/client/retail_dashboard.ejs');
const home = {
    available: true,
    monthLabel: 'أكتوبر 2026',
    summary: { totalCount: 38, completedCount: 36, pendingCount: 2 },
    recent: [
        {
            id: '6ae5008e880226d4b241969d',
            reference: 'ATT-10482',
            statusLabel: 'قيد التنفيذ',
            tone: 'info',
            serviceLabel: 'محافظ كاش',
            icon: 'fa-wallet',
            amount: 1200,
            currency: 'EGP',
            createdAt: new Date('2026-10-30T10:00:00Z'),
        },
    ],
};
const data = {
    clientTheme: 'day',
    user: { name: 'أحمد محمد', balance: 2485, accountCode: '10482', role: 'user' },
    canRequestDeposit: true,
    retailHome: home,
    csrfToken: 'test-csrf',
    pendingRateUpdate: null,
    showMfaNotice: false,
};
test('home shares navigation, renders live values, and never labels pending costs as reserved money', async () => {
    const html = await ejs.renderFile(view, data);
    expect(html).toContain('2,485.000');
    expect(html).toContain('ATT-10482');
    expect(html).toContain('data-home-transaction="6ae5008e880226d4b241969d"');
    expect(html).toContain('data-retail-operation-dialog');
    expect(html).toContain('data-ro-download hidden');
    expect(html).toContain('data-ro-share disabled');
    expect(html).not.toContain('المبلغ المحجوز');
    expect(html.match(/aria-current="page"/g) || []).toHaveLength(2);
    expect(html.match(/class="bottomnav"/g) || []).toHaveLength(1);
    expect(html).toContain('data-customer-bell');
    expect(html).not.toContain('data-company-shell');
});
test('agent-funded accounts never show the central deposit action', async () => {
    const html = await ejs.renderFile(view, { ...data, canRequestDeposit: false });
    expect(html).not.toContain('deposits-new');
    expect(html).not.toContain('طلب إضافة رصيد');
});
test('unavailable summaries display an error instead of fabricated zero or empty history', async () => {
    const html = await ejs.renderFile(view, { ...data, retailHome: { available: false } });
    expect(html).toContain('تعذر تحديث الملخص');
    expect(html).not.toContain('لا توجد تحويلات بعد');
    expect(html).not.toContain('إحصاءات التحويلات لهذا الشهر');
});
test('empty history and read-only accounts remain useful without a transfer CTA', async () => {
    const html = await ejs.renderFile(view, {
        ...data,
        user: { ...data.user, role: 'accountant' },
        retailHome: { ...home, recent: [] },
    });
    expect(html).toContain('لا توجد تحويلات بعد');
    expect(html).toContain('حسابك للعرض والمتابعة');
    expect(html).not.toContain('تحويل جديد');
    expect(html).not.toContain('ابدأ تحويلًا');
});
