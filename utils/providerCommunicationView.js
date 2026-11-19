'use strict';

const kenanStatuses = new Map(Object.entries({
    queued: 'في طابور كنان', assigned: 'أُسندت إلى منفذ كنان', executing: 'جارٍ التنفيذ',
    verifying: 'جارٍ التحقق', review: 'قيد مراجعة كنان', success: 'نجحت لدى كنان',
    failed: 'فشلت لدى كنان', cancelled: 'أُلغيت لدى كنان'
}));
const monitorStates = new Map(Object.entries({
    pending: 'بانتظار النتيجة النهائية', paid: 'رد دفع مطابق', returned: 'أفاد المزود بالاسترجاع',
    rejected: 'أفاد المزود بالرفض', mismatch: 'بيانات الرد غير مطابقة', failed: 'تعذر الاستعلام',
    missing_reference: 'يلزم رقم عملية المزود للاستعلام', missing_executor: 'تعذر تحديد حساب المزود',
    exhausted: 'توقفت المتابعة السابقة', awaiting: 'بانتظار الفحص'
}));
const kenanChecks = new Map(Object.entries({
    matched: 'رد مطابق', mismatch: 'بيانات الرد غير مطابقة',
    unavailable: 'تعذر الاستعلام', configuration: 'تعذر الاستعلام بإعدادات المنفذ'
}));
const kenanSettlement = new Map(Object.entries({
    awaiting_funding:'بانتظار تمويل حساب المنفذ', retrying_confirmation:'جارٍ إعادة محاولة التسوية المحلية',
    completed:'اكتملت التسوية المحلية'
}));
const localStates = new Map(Object.entries({
    processing:'قيد التنفيذ', pending:'معلّقة', accepted:'قيد العمل', completed:'مكتملة',
    rejected:'مرفوضة', cancelled:'ملغاة', cancelled_by_admin:'ملغاة من الإدارة'
}));
const paymentStates = new Map(Object.entries({
    accepted:'أقرّ المزود بطلب الدفع', pending:'بانتظار نتيجة الدفع النهائية',
    unknown:'نتيجة الدفع غير محسومة', rejected:'رفض المزود طلب الدفع'
}));
const preflightStages = new Map(Object.entries({
    auth:'فشلت المصادقة', inquiry:'فشل فحص الأهلية', configuration:'إعدادات الربط غير مكتملة'
}));
const formatDate = new Intl.DateTimeFormat('ar-LY', {
    timeZone:'Africa/Tripoli', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
});
const safeRef = value => {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const reference = String(value).trim();
    return /^[\w.*×＊•·/-]{1,160}$/u.test(reference) ? reference : '';
};
const dateText = value => {
    if (!value) return '';
    const time = new Date(value);
    return Number.isFinite(time.getTime()) ? formatDate.format(time) : '';
};
const statusCode = n => Number.isInteger(n) && n >= 100 && n <= 599 ? 'HTTP ' + n : '';
const marker = '--- سجل الـ API';
const receiptReadStages = new Map(Object.entries({auth:'المصادقة', print:'قراءة الإيصال', configuration:'الإعدادات'}));
const transportErrors = new Map(Object.entries({timeout:'انتهت مهلة الاتصال', connection:'تعذّر الاتصال', dns:'تعذّر حل اسم المضيف', tls:'تعذّر الاتصال المشفّر', unknown:'خطأ اتصال غير محدد'}));

function zaynTerminalLabel(data) {
    if (!data.providerMatchedAt) return '';
    switch (data.providerMatchedState) {
    case 'returned': return data.providerMatchedReversal ? 'مسترجعة لدى زين' : 'ملغاة لدى زين';
    case 'rejected': return 'مرفوضة لدى زين';
    case 'paid': return 'ناجحة لدى زين';
    default: return '';
    }
}

// Build the same allowlisted operator view for current observations and old transactions.
// Notes and arbitrary provider strings never become communications payloads in the browser.
function providerCommunicationView(tx) {
    const data = tx.apiResultData || {};
    const kenanRef = safeRef(data.kenanReference);
    const candidateId = safeRef(data.zaynFollowupAttemptId ? data.providerTransactionId
        : data.providerTransactionId || data.externalTransactionId || data.providerTransactionNumber || data.transactionNumber);
    // A few historical adapters copied the local ID into the provider ID field.
    const providerId = candidateId === String(tx.customId) || candidateId === String(tx._id) ? '' : candidateId;
    const matched = Boolean(data.providerMatchedAt);
    const payment = paymentStates.get(data.zaynPaymentReplyState);
    const kenanCreate = data.kenanCreateReplyState === 'rejected' ? 'رفض كنان طلب الإنشاء'
        : data.kenanCreateReplyState === 'unknown' ? 'نتيجة طلب الإنشاء غير محسومة' : '';
    const preflight = data.providerPreflightOutcome === 'failed' && preflightStages.get(data.providerPreflightStage);
    const kenan = Boolean(kenanRef || data.kenanLastPollAt || data.kenanReceivedAt || kenanCreate);
    const markerInNotes = [tx.adminNotes, tx.notes].some(note => typeof note === 'string' && note.includes(marker));
    const hasAttempt = Boolean(data.providerDispatchStartedAt || data.providerDispatchAttemptId);
    if (!kenan && !hasAttempt && !payment && !preflight && !providerId && !data.providerMonitorState
        && !data.providerDispatchResult && !data.providerMatchedAt && !markerInNotes) return null;

    const zayn = !kenan && Boolean(data.zaynFollowupAttemptId || payment || preflight);
    const finalLabel = zayn ? zaynTerminalLabel(data) : '';
    let rowStatus = '';
    if (zayn && tx.status === 'processing') {
        if (finalLabel) rowStatus = finalLabel;
        else if (data.providerMonitorState === 'failed') rowStatus = 'تعذّر استعلام زين';
        else if (data.providerMonitorState === 'mismatch') rowStatus = 'رد زين غير مطابق';
        else if (data.providerTransactionId) rowStatus = 'بانتظار رد زين';
    }
    const legacyAcknowledged = !payment && !data.providerResolutionOutcome && Boolean(providerId)
        && ['accepted','pending_reference'].includes(data.providerDispatchResult);
    const receiptReference = safeRef(data.providerReportedReference || data.referenceNumber);
    const settledReceipt = data.zaynPaymentReplyState === 'accepted' && /[*＊×•·]/u.test(receiptReference);
    const confirmed = Boolean(kenanRef || settledReceipt || (providerId && (matched || legacyAcknowledged ||
        ['pending','accepted'].includes(data.zaynPaymentReplyState))));
    const receipt = confirmed ? 'أكّد المزود استلام العملية'
        : preflight && !hasAttempt && !payment ? 'لم يُرسل طلب الدفع' : 'الاستلام غير مؤكّد';
    const waiting = kenan && tx.status === 'processing' && !data.providerResolutionOutcome
        && (data.kenanAwaitingStatus || data.waitingApiAutoCompletion);
    const pendingLabel = waiting ? (data.kenanProviderStatus === 'success' ? 'بانتظار إتمام التسوية' : 'بانتظار رد كنان') : '';
    const lines = [receipt];
    const add = (label, value) => { if (value) lines.push(label + ' — ' + value); };
    add('المزود', kenan ? 'كنان' : zayn ? 'Zayn Speed' : '');
    if (preflight) {
        add('قبل الدفع', [preflight, statusCode(data.providerPreflightHttpStatus)].filter(Boolean).join(' · '));
        add('وقت الفحص', dateText(data.providerPreflightAt));
    }
    add('بدء محاولة الدفع', dateText(data.providerDispatchStartedAt));
    add('رقم عملية المزود', kenanRef || providerId);
    if (!kenan && (payment || confirmed)) {
        if (receiptReference !== providerId) add('مرجع المزود', receiptReference);
    }
    add('رد الدفع', [kenan ? kenanCreate : payment, statusCode(kenan ? data.kenanCreateHttpStatus : data.zaynPaymentHttpStatus)].filter(Boolean).join(' · '));
    add('وقت رد الإنشاء', dateText(data.kenanReceivedAt || data.kenanCreateReplyAt || data.zaynPaymentReplyAt));
    const lastKenan = kenanStatuses.get(data.kenanProviderStatus || data.kenanOrder?.status);
    const monitor = monitorStates.get(data.providerMonitorState);
    add('نتيجة المزود', lastKenan || finalLabel || monitorStates.get(data.providerMatchedState) || monitorStates.get(data.zaynPaymentStatus));
    add('آخر رد مطابق', dateText(kenan ? data.kenanLastCheckedAt : data.providerMatchedAt));
    add('آخر فحص', kenan ? [kenanChecks.get(data.kenanLastPollOutcome),statusCode(data.kenanLastPollHttpStatus)].filter(Boolean).join(' · ') : monitor);
    add('وقت آخر فحص', dateText(kenan ? data.kenanLastPollAt : data.providerMonitorCheckedAt || data.providerLastCheckedAt));
    if (zayn && data.providerMonitorState === 'failed') {
        add('مرحلة الفحص', receiptReadStages.get(data.providerLastCheckStage));
        add('نتيجة الاتصال', [statusCode(data.providerLastCheckHttpStatus), transportErrors.get(data.providerLastCheckTransport)].filter(Boolean).join(' · '));
        if (Number.isSafeInteger(data.providerLastCheckProviderCode)) add('كود زين', String(data.providerLastCheckProviderCode));
        if (Number.isSafeInteger(data.providerLastCheckRetryAfterSeconds) && data.providerLastCheckRetryAfterSeconds > 0) {
            add(data.providerLastCheckRetrySource === 'provider_header' ? 'مهلة المزود' : 'مهلة إعادة المحاولة', data.providerLastCheckRetryAfterSeconds + ' ثانية');
        }
    }
    add('الاستعلام التالي', dateText(kenan ? (data.kenanAwaitingStatus && data.kenanNextPollAt) : (!data.providerMonitorStopped && data.providerMonitorNextCheckAt)));
    add('حالة الموقع', localStates.get(tx.status));
    if (kenan) add('التسوية', kenanSettlement.get(data.kenanCompletionState));
    if (pendingLabel) lines.push(pendingLabel);
    return { confirmed, title: 'سجل التخاطب مع المزود', receipt, text:lines.join('\n'), pendingLabel, rowStatus };
}

// These are view objects detached from MongoDB. Historical rows can contain the
// provider's entire reply in notes or providerLastCheckedRaw. Keep them on the
// server when serializing list snapshots and the administrative details API.
function redactLegacyProviderData(transaction) {
    for (const field of ['notes', 'adminNotes']) {
        const value = transaction[field];
        if (typeof value !== 'string') continue;
        const start = value.indexOf(marker);
        if (start >= 0) transaction[field] = value.slice(0, start) + marker + ' ---';
    }
    if (transaction.apiResultData) delete transaction.apiResultData.providerLastCheckedRaw;
    return transaction;
}

module.exports = { providerCommunicationView, redactLegacyProviderData };
