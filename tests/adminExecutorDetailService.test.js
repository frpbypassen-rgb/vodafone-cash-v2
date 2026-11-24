'use strict';
const {normalizeExecutorDetailQuery,buildExecutorHistoryPipeline,loadExecutorHistory,loadOtherExecutorMatches} = require('../services/adminExecutorDetailService');
test('normalizes dates using the Libya day and rejects invalid calendar ranges', () => {
    const today=normalizeExecutorDetailQuery({period:'today'},new Date('2026-10-27T22:15:00Z'));
    expect(today.from).toBe('2026-10-28');
    expect(today.to).toBe('2026-10-28');
    expect(normalizeExecutorDetailQuery({from:'2026-02-31'}).error).toBeTruthy();
    expect(normalizeExecutorDetailQuery({from:'2026-10-03',to:'2026-10-01'}).error).toBeTruthy();
    expect(normalizeExecutorDetailQuery({tab:'unknown',page:'-3',status:'$where'})).toMatchObject({tab:'ledger',page:1,status:''});
    expect(normalizeExecutorDetailQuery({employeePolicyUpdated:'1'}).tab).toBe('staff');
    expect(normalizeExecutorDetailQuery({depositRequest:'DEP-1'}).tab).toBe('deposits');
    expect(normalizeExecutorDetailQuery({tab:'operations',q:'#ATT-2611-28592'}).q).toBe('ATT-2611-28592');
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
    expect(p[0]).toEqual({$match:{$and:[{executorGroupId:'own'},{status:{$nin:['deposit','deduction','deposit_pending']}}]}});
    expect(p.some(s=>s.$setWindowFields)).toBe(false);
    const Transaction={aggregate:jest.fn()};
    const staff=await loadExecutorHistory(Transaction,{_id:'own'},{tab:'staff'});
    expect(staff.rows).toEqual([]);
    expect(Transaction.aggregate).not.toHaveBeenCalled();
});

test('deposits are a separate history of submitted and approved deposits', () => {
    const p=buildExecutorHistoryPipeline({_id:'own'},normalizeExecutorDetailQuery({tab:'deposits'}));
    expect(p[0].$match).toEqual({$and:[{executorGroupId:'own'},{status:{$in:['deposit','deposit_pending']}}]});
    expect(p.some(s=>s.$setWindowFields)).toBe(false);
});

test('global lookup returns only other executor operations within admin visibility scope', async () => {
    const rows=[{customId:'ATT-2611-28592',executorGroupId:{_id:'other',name:'منفذ آخر'},status:'completed'}];
    const query={select:jest.fn(),sort:jest.fn(),limit:jest.fn(),populate:jest.fn(),lean:jest.fn().mockResolvedValue(rows)};
    query.select.mockReturnValue(query); query.sort.mockReturnValue(query); query.limit.mockReturnValue(query); query.populate.mockReturnValue(query);
    const Transaction={find:jest.fn().mockReturnValue(query)};
    expect(await loadOtherExecutorMatches(Transaction,{_id:'own'},{tab:'operations',q:'28592'},{tenantId:'tenant-a'})).toEqual(rows);
    const filter=Transaction.find.mock.calls[0][0];
    expect(filter.tenantId).toBe('tenant-a');
    expect(filter.$and).toContainEqual({executorGroupId:{$exists:true,$ne:'own'}});
    expect(filter.$and.find(item=>item.$or).$or[0].customId.test('ATT-2611-28592')).toBe(true);
    expect(query.limit).toHaveBeenCalledWith(8);
    Transaction.find.mockClear();
    expect(await loadOtherExecutorMatches(Transaction,{_id:'own'},{tab:'operations',q:''},{})).toEqual([]);
    expect(Transaction.find).not.toHaveBeenCalled();
});
