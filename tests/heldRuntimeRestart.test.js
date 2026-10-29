'use strict';
const {validateHeld,validateQueues}=require('../scripts/checkHeldRuntimeRestart.cjs');
const dispatch=require('../services/providerDispatchClaimService');
const {assertManual,parseManifest}=require('../scripts/manualRestartSnapshot.cjs');
const held=()=>({_id:'fixture',status:'processing',updatedAt:new Date('2026-10-29T11:47:46Z'),
    apiResultData:{providerDispatchStartedAt:new Date('2026-10-29T11:46:57Z'),providerDispatchResult:'pending_reference',providerResultUnresolved:true,waitingApiAutoCompletion:false}});
test('preserves the whole held document and rejects any changed snapshot',()=>{
    const tx=held(),before=JSON.stringify(tx),hash=validateHeld(tx);
    expect(dispatch.automaticPaymentBlocked(tx)).toBe(true);
    expect(dispatch.refundBlockedByUnresolvedProvider(tx)).toMatchObject({code:'PROVIDER_RESULT_UNRESOLVED'});
    expect(validateHeld(tx,hash)).toBe(hash);expect(JSON.stringify(tx)).toBe(before);
    tx.updatedAt=new Date();expect(()=>validateHeld(tx,hash)).toThrow('HELD_DOCUMENT_CHANGED');
});
test.each([
    tx=>{tx.status='completed';},tx=>{tx.apiResultData.providerDispatchResult='accepted';},
    tx=>{tx.apiResultData.providerResultUnresolved=false;},tx=>{tx.apiResultData.waitingApiAutoCompletion=true;},
    tx=>{delete tx.apiResultData.providerDispatchStartedAt;}
])('refuses a transaction that is no longer the specific unresolved hold',change=>{
    const tx=held();change(tx);expect(()=>validateHeld(tx)).toThrow('HELD_STATE_CHANGED');
});
const clear=()=>({mongo:{connected:true},transactions:{sampled:1,truncated:false,statuses:{processing:1}},queues:Object.fromEntries(
    ['api-transfers-queue','notifications-queue','reports-queue','backups-queue','reconciliations-queue'].map(q=>[q,{active:0,wait:0,delayed:0,prioritized:0,'waiting-children':0}]))});
test('permits only the one held transaction and complete empty queue inspections',()=>{
    expect(()=>validateQueues(clear())).not.toThrow();
    const other=clear();other.transactions.sampled=2;expect(()=>validateQueues(other)).toThrow();
    const incomplete=clear();delete incomplete.queues['api-transfers-queue'].active;expect(()=>validateQueues(incomplete)).toThrow();
    const truncated=clear();truncated.transactions.truncated=true;expect(()=>validateQueues(truncated)).toThrow();
});
test.each(['active','wait','delayed','prioritized','waiting-children'])('refuses queue work in %s',field=>{
    const report=clear();report.queues['api-transfers-queue'][field]=1;expect(()=>validateQueues(report)).toThrow('QUEUES_NOT_EMPTY');
});

test.each(['completed','rejected','cancelled_by_admin'])('explicit settled mode preserves existing %s without changing it',status=>{
    const tx=held();tx.status=status;const before=JSON.stringify(tx);
    expect(()=>validateHeld(tx)).toThrow('HELD_STATE_CHANGED');
    const hash=validateHeld(tx,undefined,true);
    expect(validateHeld(tx,hash,true)).toBe(hash);expect(JSON.stringify(tx)).toBe(before);
    tx.updatedAt=new Date();expect(()=>validateHeld(tx,hash,true)).toThrow('HELD_DOCUMENT_CHANGED');
});
test('empty work is accepted only in explicit settled mode and missing transactions never pass',()=>{
    const report=clear();report.transactions={sampled:0,truncated:false,statuses:{}};
    expect(()=>validateQueues(report)).toThrow();expect(()=>validateQueues(report,true)).not.toThrow();
    expect(()=>validateHeld(null,undefined,true)).toThrow('HELD_STATE_CHANGED');
    for(const status of ['pending','accepted','deposit_pending','unknown']) {
        const tx=held();tx.status=status;expect(()=>validateHeld(tx,undefined,true)).toThrow('HELD_STATE_CHANGED');
    }
    report.queues['api-transfers-queue'].active=1;expect(()=>validateQueues(report,true)).toThrow('QUEUES_NOT_EMPTY');
});
test('busy work diagnostics expose only counts and incomplete inspections never become busy work',()=>{
    const report=clear();report.transactions={sampled:2,truncated:false,statuses:{pending:1,processing:1}};
    let caught;try{validateQueues(report,true);}catch(error){caught=error;}
    expect(caught.message).toBe('OTHER_OPEN_TRANSACTION');
    expect(caught.summary).toEqual({sampled:2,statuses:{pending:1,processing:1,accepted:0,deposit_pending:0}});
    report.mongo.connected=false;expect(()=>validateQueues(report,true)).toThrow('TRANSACTION_INSPECTION_NOT_CLEAR');
    const missing=clear();delete missing.queues['api-transfers-queue'].wait;
    expect(()=>validateQueues(missing,true)).toThrow('QUEUE_INSPECTION_INCOMPLETE');
});
test('idle manual acceptance and unassigned pending work are distinguishable from active API work',()=>{
    expect(()=>assertManual({status:'pending'},null)).not.toThrow();
    expect(()=>assertManual({status:'accepted',executorGroupId:'fixture'},{isApiBot:false})).not.toThrow();
    for(const tx of [{status:'processing'},{status:'accepted'},{status:'pending',originalApiGroupId:'api'},
        {status:'pending',apiResultData:{providerDispatchAttemptId:'sent'}},{status:'pending',apiResultData:{waitingApiAutoCompletion:true}}])
        expect(()=>assertManual(tx,null)).toThrow('UNSAFE_OPEN_TRANSACTION');
    expect(()=>assertManual({status:'accepted',executorGroupId:'fixture'},{isApiBot:true})).toThrow();
    expect(()=>assertManual({status:'accepted',executorGroupId:'fixture'},{})).toThrow();
    expect(()=>parseManifest('invalid')).toThrow('INVALID_ARGUMENT');
});
