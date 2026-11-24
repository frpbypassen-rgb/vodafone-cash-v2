'use strict';

const { providerCommunicationView, redactLegacyProviderData } = require('../utils/providerCommunicationView');
const path = require('node:path');
const ejs = require('ejs');
const at = new Date('2026-11-19T10:00:00Z');
const row = data => ({ status: 'processing', apiResultData: data });

test.each([
    ['returned', false, 'ملغاة لدى زين'],
    ['returned', true, 'مسترجعة لدى زين'],
    ['rejected', false, 'مرفوضة لدى زين'],
    ['paid', false, 'ناجحة لدى زين']
])('shows a matched terminal receipt on the row separately from local settlement', (state, reversed, label) => {
    const tx = row({zaynFollowupAttemptId:'a', providerDispatchAttemptId:'a', providerTransactionId:'123',
        providerMatchedState:state, providerMatchedAt:at, providerMatchedReversal:reversed});
    expect(providerCommunicationView(tx).rowStatus).toBe(label);
    expect(providerCommunicationView(tx).text).toContain('حالة الموقع — قيد التنفيذ');
    delete tx.apiResultData.providerMatchedAt;
    expect(providerCommunicationView(tx).rowStatus).not.toBe(label);
});

test('reports a failed receipt read with only allowlisted diagnostics and no invented cancellation', () => {
    const tx = row({zaynFollowupAttemptId:'a', providerDispatchAttemptId:'a', providerMonitorState:'failed',
        providerLastCheckStage:'print', providerLastCheckHttpStatus:429, providerLastCheckProviderCode:429,
        providerLastCheckRetryAfterSeconds:90, providerLastCheckRetrySource:'provider_header', providerLastCheckTransport:'SECRET'});
    const view = providerCommunicationView(tx);
    expect(view.rowStatus).toBe('تعذّر استعلام زين');
    expect(view.text).toContain('HTTP 429');
    expect(view.text).toContain('90');
    expect(view.text).not.toMatch(/SECRET|ملغاة/);
});

test('a local dispatch or uncorrelated HTTP reply never confirms provider receipt', () => {
    for (const data of [
        { providerDispatchStartedAt: at },
        { zaynPaymentReplyState: 'unknown', zaynPaymentHttpStatus: 200, zaynPaymentReplyAt: at }
    ]) {
        const result = providerCommunicationView(row(data));
        expect(result.text).toContain('الاستلام غير مؤكّد');
        expect(result.confirmed).toBe(false);
    }
});

test('failed authentication is shown as an upstream login failure before any payment dispatch', () => {
    const result = providerCommunicationView(row({ providerPreflightOutcome:'failed', providerPreflightStage:'auth',
        providerPreflightAt:at, providerPreflightHttpStatus:429 }));
    expect(result.confirmed).toBe(false);
    expect(result.text).toContain('لم يُرسل طلب الدفع');
    expect(result.text).toContain('فشلت المصادقة · HTTP 429');
});

test.each([['rejected',422,'رفض كنان'],['unknown',502,'غير محسومة']])(
    'Kenan create %s without a provider reference stays unconfirmed', (state,http,expected) => {
        const result = providerCommunicationView(row({kenanCreateReplyState:state,kenanCreateReplyAt:at,kenanCreateHttpStatus:http}));
        expect(result.confirmed).toBe(false);
        expect(result.text).toContain(expected);
        expect(result.text).toContain('HTTP '+http);
        expect(result.text).not.toContain('رقم عملية المزود');
    });

test('manual decisions and historical local IDs cannot stand in for a provider acknowledgment', () => {
    const legacy = {status:'completed',customId:'ATT-TEST',apiResultData:{
        providerDispatchResult:'accepted',providerTransactionId:'ATT-TEST' }};
    expect(providerCommunicationView(legacy).confirmed).toBe(false);
    legacy.apiResultData.providerTransactionId = '0000020';
    legacy.apiResultData.providerResolutionOutcome = 'provider_paid';
    expect(providerCommunicationView(legacy).confirmed).toBe(false);
});

test('a settled payment with a masked receipt can confirm without inventing a provider transaction ID', () => {
    const result = providerCommunicationView(row({zaynFollowupAttemptId:'current',providerDispatchAttemptId:'current',
        zaynPaymentReplyState:'accepted', referenceNumber:'ABC/20**.1',transactionNumber:'OLD-INVOCATION'}));
    expect(result.confirmed).toBe(true);
    expect(result.text).toContain('مرجع المزود — ABC/20**.1');
    expect(result.text).not.toMatch(/رقم عملية المزود|OLD-INVOCATION/);
});

test('a generic historic HTTP-success flag without a matching receipt is inconclusive', () => {
    const result = providerCommunicationView(row({providerStatusCheckSucceeded:true,providerTransactionId:'1001',
        providerMonitorState:'mismatch'}));
    expect(result.confirmed).toBe(false);
});

test('records a Kenan receipt, a failed later read, and the unfinished local settlement separately', () => {
    const result = providerCommunicationView(row({
        kenanReference: '0000014', kenanProviderStatus: 'success', kenanReceivedAt: at,
        kenanLastPollOutcome: 'unavailable', kenanLastPollHttpStatus: 503,
        kenanLastPollAt: at, kenanLastCheckedAt: at, waitingApiAutoCompletion: true, kenanCompletionState:'awaiting_funding'
    }));
    expect(result.confirmed).toBe(true);
    expect(result.text).toContain('0000014');
    expect(result.text).toContain('نجحت لدى كنان');
    expect(result.text).toContain('503');
    expect(result.text).toContain('بانتظار إتمام التسوية');
    expect(result.text).toContain('بانتظار تمويل حساب المنفذ');
});

test('matched Zayn evidence survives a failed later read and preserves its exact provider transaction number', () => {
    const result = providerCommunicationView(row({
        zaynFollowupAttemptId: 'a', providerDispatchAttemptId: 'a',
        providerTransactionId: '00042', providerMatchedAt: at, providerMatchedState:'pending', providerReportedStatus: 'pending',
        providerMonitorState: 'failed', providerMonitorCheckedAt: at, providerMonitorNextCheckAt: at
    }));
    expect(result.confirmed).toBe(true);
    expect(result.text).toContain('00042');
    expect(result.text).toContain('تعذر الاستعلام');
    expect(result.text).toContain('بانتظار النتيجة النهائية');
    expect(result.text).toContain('الاستعلام التالي');
});

test('a historic log marker without corroboration exposes no raw payload or user notes', () => {
    const old = {status:'completed', adminNotes:'--- سجل الـ API ---\nsecret-customer-note', apiResultData:{
        providerReportedStatus:'private-data', providerReportedReference:'invalid private reference'
    }};
    const result = providerCommunicationView(old);
    expect(result.confirmed).toBe(false);
    expect(result.text).not.toMatch(/secret-customer-note|private/);
    expect(providerCommunicationView({status:'completed',notes:'ordinary note'})).toBeNull();
});

test('the live API room displays a compact log even before raw notes exist and treats local status independently', async () => {
    const tx = {_id:'t1', createdAt:at, updatedAt:at, amount:100, status:'processing', notes:'',
        apiResultData:{kenanReference:'0000014', kenanProviderStatus:'queued', kenanAwaitingStatus:true}};
    const view = path.join(__dirname, '../views/api_room.ejs');
    const html = await ejs.renderFile(view, {providerCommunicationView, bot:{_id:'e1',name:'Test',apiProviderKey:'kenan'},
        transactions:[tx, {...tx,_id:'t2',status:'completed',notes:'--- سجل الـ API ---\nPRIVATE-WIRE',apiResultData:{}}],
        role:'admin', csrfToken:'fixture', adminName:'Test', query:{}, isMaster:false, managerBots:[], balanceAudits:[], providerReturns:[],
        apiSearchTerm:'28592', depositHistory:[{customId:'DEP-1',amount:100,status:'deposit',createdAt:at}],
        otherExecutorMatches:[{customId:'ATT-2611-28592',amount:970,status:'completed',vodafoneNumber:'0912345678',executorGroupId:{_id:'other',name:'منفذ آخر'}}],
        stats:{successCount:1,failedCount:0,balanceAlertCount:0,providerReturnCount:0}});
    expect(html.match(/data-provider-communication=/g)).toHaveLength(2);
    expect(html).toContain('0000014');
    expect(html).toContain('id="apiOperationSearch"');
    expect(html).toContain('سجل الإيداعات السابقة');
    expect(html).toContain('فتح حساب منفذ آخر');
    expect(html).not.toMatch(/PRIVATE-WIRE|نجاح \(200 OK\)|خطأ استجابة/);
});

test('serialized transaction rows and details retain only notes preceding the legacy wire block', () => {
    const result = redactLegacyProviderData({notes:'customer note',apiResultData:{providerLastCheckedRaw:{private:'wire'}},adminNotes:'operator note\n--- سجل الـ API (Terminal Log) ---\nsecret wire contents'});
    expect(result.notes).toBe('customer note');
    expect(result.apiResultData.providerLastCheckedRaw).toBeUndefined();
    expect(result.adminNotes).toContain('operator note');
    expect(result.adminNotes).not.toContain('secret wire contents');
    expect(providerCommunicationView(result)).not.toBeNull();
});
