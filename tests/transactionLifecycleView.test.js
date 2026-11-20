'use strict';

const { buildLifecycle } = require('../services/transactionLifecycleView');

const at = minute => new Date(Date.UTC(2026, 10, 20, 12, minute));
const tx = { _id:'db-id', customId:'ATT-TEST-12', createdAt:at(0), updatedAt:at(14), status:'cancelled_by_admin',
    cancelledAt:at(13), cancellationNumber:'CANCEL-12', companyId:'company-id', companyName:'شركة تجريبية',
    employeeName:'مقدّم الطلب', clientActorModel:'ClientEmployee' };

test('joins legacy and durable routing with actual wallet entries and the saved state', () => {
    const routed = { action:'TRANSACTION_ROUTED', performedByName:'مدير التوجيه الأول', createdAt:at(2),
        newData:{ executorName:'شركة التنفيذ الأولى' } };
    const pulled = { action:'TRANSACTION_PULLED', performedByName:'مدير السحب', createdAt:at(5),
        oldData:{ executorName:'المنفذ الأول', routedByAdminName:'مدير التوجيه الأول' }, metadata:{ lifecycleRecorded:true } };
    const result = buildLifecycle({
        ...tx, routingHistory:[
            { kind:'executor_accepted', at:at(3), actor:'المنفذ الأول', executor:'المنفذ الأول' },
            { kind:'admin_pulled', at:at(5), actor:'مدير السحب', executor:'المنفذ الأول', previousRouter:'مدير التوجيه الأول' },
            { kind:'admin_routed', at:at(6), actor:'مدير إعادة التوجيه', executor:'شركة التنفيذ الثانية' },
            { kind:'executor_assigned', at:at(7), actor:'مدير التنفيذ الثاني', executor:'المنفذ الثاني' },
            { kind:'executor_accepted', at:at(8), actor:'المنفذ الثاني' }
        ], completedAt:at(10)
    }, {
        audits:[routed,pulled,
            { action:'TASK_ACCEPTED', createdAt:new Date(at(3).getTime()+500), performedByName:'المنفذ الأول' },
            { action:'TRANSFER_COMPLETED', createdAt:at(11), performedByName:'المنفذ الثاني' },
            { action:'TRANSACTION_CANCELLED_BY_ADMIN', createdAt:at(13), performedByName:'مدير الإلغاء' }],
        canReadFinance:true,
        ledgers:[
            { _id:'wallet-debit', type:'TRANSFER', entityModel:'ClientCompany', amount:-21, balanceBefore:200, balanceAfter:179, createdAt:at(1) },
            { _id:'executor-debit', type:'TRANSFER', entityModel:'ExecutorGroup', amount:-100, balanceBefore:500, balanceAfter:400, createdAt:at(10) },
            { _id:'refund', type:'REFUND', entityModel:'ClientCompany', amount:21, balanceBefore:179, balanceAfter:200, createdAt:at(13) }
        ]
    });
    expect(result.source).toMatchObject({kind:'company', name:'شركة تجريبية'});
    expect(result.record).toMatchObject({ id:'db-id', reference:'ATT-TEST-12', status:'cancelled_by_admin', cancellationNumber:'CANCEL-12' });
    expect(result.events.map(event => event.kind)).toEqual([
        'created','debit','admin_routed','executor_accepted','admin_pulled','admin_routed','executor_assigned','executor_accepted','debit','completed','refund','cancelled'
    ]);
    expect(result.events[4]).toMatchObject({ actor:'مدير السحب', executor:'المنفذ الأول',previousRouter:'مدير التوجيه الأول' });
    expect(result.events[5]).toMatchObject({ actor:'مدير إعادة التوجيه', executor:'شركة التنفيذ الثانية', label:'أعادت الإدارة توجيه العملية' });
    expect(result.finance.movements).toEqual([
        expect.objectContaining({ role:'sender', currency:'LYD', amount:-21, balanceBefore:200, balanceAfter:179 }),
        expect.objectContaining({ role:'executor', currency:'EGP', amount:-100, balanceBefore:500, balanceAfter:400 }),
        expect.objectContaining({ kind:'refund', currency:'LYD', amount:21, balanceAfter:200 })
    ]);
});

test.each([
    [{ clientActorModel:'User', companyId:null }, { role:'user' }, 'client'],
    [{ clientActorModel:'User', companyId:null }, { role:'agent' }, 'agent'],
    [{ clientActorModel:'AgentEmployee' }, null, 'agent'],
    [{ clientActorModel:'SubAccount', subAccountId:'sub' }, { masterType:'user' }, 'agency_client'],
    [{ clientActorModel:'SubAccount', subAccountId:'sub' }, { masterType:'company' }, 'company_client'],
    [{ clientActorModel:'SubAccount', subAccountId:'sub' }, null, 'sub_client']
])('classifies the stored source by its audited relationship (%j)', (fields, account, expected) => {
    expect(buildLifecycle({ ...tx, ...fields }, { account }).source.kind).toBe(expected);
});

test('does not infer refunded balances or fabricate timing for old records', () => {
    const legacy = { ...tx, status:'rejected', cancelledAt:undefined, updatedAt:at(13), hiddenSecret:'omitted' };
    const data = buildLifecycle(legacy, {
        canReadFinance:true,
        audits:[{ action:'TRANSACTION_PULLED', success:false, performedByName:'failed-attempt', createdAt:at(5) }]
    });
    expect(data.events.at(-1)).toMatchObject({ kind:'rejected', at:null });
    expect(data.finance.movements).toEqual([]);
    expect(JSON.stringify(data)).not.toMatch(/hiddenSecret|failed-attempt/);

    const scoped = buildLifecycle(tx, {
        canReadFinance:false, ledgers:[{type:'REFUND',amount:100,balanceAfter:1000}]
    });
    expect(scoped.finance).toMatchObject({ available:false, movements:[] });
    expect(scoped.events.some(event => event.kind === 'refund')).toBe(false);
});

test('uses each service currency for executor debits and preserves client wallet currency', () => {
    const result = buildLifecycle({ ...tx, transferType:'sefa_niger' }, {
        canReadFinance:true, ledgers:[
            { _id:'client', type:'TRANSFER', entityModel:'ClientCompany', amount:-20, settledCurrency:'LYD' },
            { _id:'executor', type:'TRANSFER', entityModel:'ExecutorGroup', amount:-500, settledCurrency:'LYD' }
        ]
    });
    expect(result.finance.movements.map(row => row.currency)).toEqual(['LYD','XOF']);
});
