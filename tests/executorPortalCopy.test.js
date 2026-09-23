'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const dashboardView = read('views/executor/dashboard.ejs');
const settingsView = read('views/executor/settings.ejs');
const depositsView = read('views/executor/deposits.ejs');
const navigationView = read('views/executor/partials/navigation.ejs');
const dashboardController = read('controllers/executorDashboardController.js');

describe('executor portal copy contracts', () => {
    test('live-queue cards name bank / sefa / bankak instead of defaulting to cash', () => {
        expect(dashboardView).toContain("bank_account: { name: 'تحويل بنكي'");
        expect(dashboardView).toContain('function isBankTransferCompletion()');
        expect(dashboardView).toContain('id="bankTransferCompletionNote"');
        expect(dashboardView).toContain('تُرسل صورة الإثبات نفسها للعميل');
        expect(dashboardView).toContain('id="splitOperationBlock"');
        expect(dashboardView).toContain("sefa_niger: { name: 'سيفا النيجر'");
        expect(dashboardView).toContain("bankak_sudan: { name: 'بنكك السودان'");
        expect(dashboardView).toContain("|| { name: 'عملية تنفيذ'");
        expect(dashboardView).not.toContain("t.transferType === 'post_card' ? 'تحويل بريد بطاقة' : 'تحويل محفظة كاش'");
    });

    test('profile and nav use the same Arabic role labels', () => {
        expect(navigationView).toContain("'مدير تنفيذي'");
        expect(navigationView).toContain("'منفّذ خارجي'");
        expect(dashboardView).toContain("'مدير تنفيذي'");
        expect(dashboardView).toContain("'منفّذ خارجي'");
        expect(dashboardView).not.toContain("'مدير النظام'");
        expect(dashboardView).not.toContain("'منفذ العمليات'");
    });

    test('settings shows the catalog Arabic service label, not the raw serviceKey', () => {
        expect(dashboardController).toContain('getExecutorServiceLabel');
        expect(dashboardController).toContain('serviceLabel: getExecutorServiceLabel');
        expect(settingsView).toContain('serviceLabel');
        expect(settingsView).not.toContain('overview.company?.serviceKey || emp.groupId?.serviceKey');
    });

    test('accountant deposit page is view-only copy, not accept/cancel copy', () => {
        expect(depositsView).toContain('هذا الحساب للعرض فقط');
        expect(depositsView).toContain('القبول والإلغاء لمدير التنفيذ');
        expect(depositsView).toContain("emp.role === 'manager'");
    });
});
