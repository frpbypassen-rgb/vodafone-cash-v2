'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const employeesView = read('views/executor/employees.ejs');
const commandBar = read('views/executor/partials/command-bar.ejs');
const depositsView = read('views/executor/deposits.ejs');
const settingsView = read('views/executor/settings.ejs');
const osCss = read('public/css/executor-os.css');
const portalRoutes = read('routes/executorPortal.js');

describe('executor pool manager UI contracts', () => {
    test('command bar keeps إجمالي / خاص labels on phone-width', () => {
        expect(commandBar).toContain('data-company-balance="total"');
        expect(commandBar).toContain('data-company-balance="private"');
        expect(commandBar).toContain('exo-balance-full">إجمالي الرصيد');
        expect(commandBar).toContain('exo-balance-short">إجمالي');
        expect(commandBar).toContain('exo-balance-full">الرصيد الخاص');
        expect(commandBar).toContain('exo-balance-short">خاص');
        expect(commandBar).toContain('data-company-balance="service-private"');
        expect(osCss).toContain('.exo-chip.exo-balance .exo-balance-short');
        expect(osCss).not.toMatch(/\.exo-chip span \{ display: none; \}/);
    });

    test('employees view uses consistent AR labels and a solo vs pool workspace', () => {
        expect(employeesView).not.toContain('editExecutionPolicy');
        expect(employeesView).toContain("include('partials/service-balance-cards'");
        expect(employeesView).toContain('مجموعة رصيد');
        expect(employeesView).toContain('منفّذ خارجي');
        expect(employeesView).toContain('id="externalPoolWorkspace"');
        expect(employeesView).toContain('id="soloList"');
        expect(employeesView).toContain('منفّذون خارجيون منفردون');
        expect(employeesView).toContain('للمستلم فقط');
        expect(employeesView).toContain('يُخصم من: <b>الرصيد الخاص</b>');
        expect(employeesView).toContain('window.executorCsrfToken');
        expect(employeesView).toContain("executorApiFetch('/executor-portal/api/balance-pools'");
        expect(employeesView).toContain('/executor-portal/api/balance-pools/\' + id + \'/rename');
        expect(employeesView).toContain('/executor-portal/api/balance-pools/\' + poolId + \'/members');
        expect(employeesView).toContain('/members/${employeeId}/detach');
        expect(employeesView).toContain('/archive');
    });

    test('deposits and settings explain إجمالي vs خاص for managers', () => {
        const balanceCards = read('views/executor/partials/service-balance-cards.ejs');
        expect(depositsView).toContain("include('partials/command-bar'");
        expect(depositsView).toContain("include('partials/service-balance-cards'");
        expect(depositsView).toContain('قبول وإضافة للرصيد الخاص');
        expect(settingsView).toContain("include('partials/service-balance-cards'");
        expect(balanceCards).toContain('تمويل منفّذ خارجي يُخصم من هنا');
        expect(balanceCards).toContain('إجمالي الرصيد');
        expect(balanceCards).toContain('row.privateLabel');
        expect(balanceCards).toContain('row.singleLabel');
    });

    test('portal pool mutations stay on manager CSRF-backed routes', () => {
        expect(portalRoutes).toContain("router.post('/api/balance-pools', requireExecutorManager");
        expect(portalRoutes).toContain("router.post('/api/balance-pools/:id/rename', requireExecutorManager");
        expect(portalRoutes).toContain("router.post('/api/balance-pools/:id/members', requireExecutorManager");
        expect(portalRoutes).toContain("router.post('/api/balance-pools/:id/members/:employeeId/detach', requireExecutorManager");
        expect(portalRoutes).toContain("router.post('/api/balance-pools/:id/archive', requireExecutorManager");
        expect(portalRoutes).toContain("router.post('/api/employees/external-transaction/:id', requireExecutorManager");
    });
});
