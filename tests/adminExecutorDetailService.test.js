'use strict';
const {normalizeExecutorDetailQuery,buildExecutorHistoryPipeline,loadExecutorHistory} = require('../services/adminExecutorDetailService');
test('normalizes dates using the Libya day and rejects invalid calendar ranges', () => {
    const today=normalizeExecutorDetailQuery({period:'today'},new Date('2026-10-27T22:15:00Z'));
    expect(today.from).toBe('2026-10-28');
    expect(today.to).toBe('2026-10-28');
    expect(normalizeExecutorDetailQuery({from:'2026-02-31'}).error).toBeTruthy();
    expect(normalizeExecutorDetailQuery({from:'2026-10-03',to:'2026-10-01'}).error).toBeTruthy();
    expect(normalizeExecutorDetailQuery({tab:'unknown',page:'-3',status:'$where'})).toMatchObject({tab:'ledger',page:1,status:''});
    expect(normalizeExecutorDetailQuery({employeePolicyUpdated:'1'}).tab).toBe('staff');
});
test('financial ownership matches manager accounting and excludes external allocation movements', () => {
    const pipeline=buildExecutorHistoryPipeline({_id:'manager',isManagerBot:true},normalizeExecutorDetailQuery());
    expect(pipeline[0].$match.$and[0]).toEqual({$or:[
        {executorGroupId:'manager',status:{$in:['deposit','deduction']}},
        {managerGroupId:'manager',status:'completed'}
    ]});
    expect(pipeline[0].$match.$and[1].transferType).toEqual({$ne:'external_balance'});
    const manual=buildExecutorHistoryPipeline({_id:'own'},normalizeExecutorDetailQuery());
    expect(manual[0].$match.$and[0]).toEqual({executorGroupId:'own'});
});
test('balances precede date, service, status and literal search filtering, with per-service partitions', () => {
    const p=buildExecutorHistoryPipeline({_id:'own'},normalizeExecutorDetailQuery({q:'A.*',from:'2026-10-01',to:'2026-10-02',service:'bank_account',status:'completed'}));
    const window=p.findIndex(s=>s.$setWindowFields);
    const filter=p.findIndex(s=>s.$match?.at);
    expect(window).toBeLessThan(filter);
    expect(p[window].$setWindowFields.partitionBy).toBe('$service');
    const match=p[filter].$match;
    expect(match.at.$gte.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(match.$or[0].customId.test('A.*')).toBe(true);
    expect(match.$or[0].customId.test('A999')).toBe(false);
    expect(match.service).toBe('bank_account');
    expect(p.at(-1).$facet.rows.at(-1)).toEqual({$limit:20});
});
test('operations keep pending states without inventing financial balances and staff avoids history queries', async () => {
    const p=buildExecutorHistoryPipeline({_id:'own'},normalizeExecutorDetailQuery({tab:'operations',status:'pending'}));
    expect(p[0]).toEqual({$match:{executorGroupId:'own'}});
    expect(p.some(s=>s.$setWindowFields)).toBe(false);
    const Transaction={aggregate:jest.fn()};
    const staff=await loadExecutorHistory(Transaction,{_id:'own'},{tab:'staff'});
    expect(staff.rows).toEqual([]);
    expect(Transaction.aggregate).not.toHaveBeenCalled();
});
