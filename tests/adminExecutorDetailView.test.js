'use strict';
const ejs = require('ejs');
const path = require('path');

const render = (tab, overrides = {}) => ejs.renderFile(path.join(__dirname, '../views/partials/admin_executor_detail_history.ejs'), {
    bot: {_id:'own',name:'منفذ تجريبي',serviceKey:'vodafone'},
    history: {filters:{tab,q:'',status:'',service:'',from:'',to:'',period:'',error:''},rows:[],total:0,page:1,totalPages:1},
    otherExecutorMatches: [],
    detailLabels: {ledger:'كشف الحساب',deposits:'الإيداعات',operations:'العمليات'},
    detailUrl: (key) => `/executor/own?tab=${key}`,
    detailMoney: value => Number(value || 0).toFixed(2), detailColor: () => '',
    detailStatuses: {completed:'مكتملة',deposit:'إيداع',deposit_pending:'قيد المراجعة'},
    executorServiceOptions: [], enabledServiceKeys:['vodafone'],
    ...overrides
});

test('deposits section separates the settlement form from previous deposit records', async () => {
    const html = await render('deposits', {history:{filters:{tab:'deposits',q:'',status:'',service:'',from:'',to:'',period:'',error:''},rows:[],total:0,page:1,totalPages:1}});
    expect(html).toContain('id="settlementForm"');
    expect(html).toContain('سجل الإيداعات');
});

test('operations search shows another executor in a distinct result card', async () => {
    const html = await render('operations', {
        history:{filters:{tab:'operations',q:'28592',status:'',service:'',from:'',to:'',period:'',error:''},rows:[],total:0,page:1,totalPages:1},
        otherExecutorMatches:[{_id:'tx-1',customId:'ATT-2611-28592',amount:970,status:'completed',vodafoneNumber:'0912345678',executorGroupId:{_id:'other',name:'منفذ الشرق'},createdAt:new Date('2026-11-19T20:00:00Z')}]
    });
    expect(html).toContain('منفذ الشرق');
    expect(html).toContain('ATT-2611-28592');
    expect(html).toContain('href="/executor/other?tab=operations&amp;q=ATT-2611-28592"');
    expect(html).toContain('0912345678');
});
