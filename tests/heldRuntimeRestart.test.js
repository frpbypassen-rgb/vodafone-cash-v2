'use strict';
const {validateHeld,validateQueues}=require('../scripts/checkHeldRuntimeRestart.cjs');
const dispatch=require('../services/providerDispatchClaimService');
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
