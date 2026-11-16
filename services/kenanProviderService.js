'use strict';

const axios = require('axios');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const { isExternalApiEnabled, isKenanFollowupEnabled, resolveProviderBaseUrl, isStagingRuntime } = require('../utils/runtimeControls');
const { UNRESOLVED_CODE, claimProviderDispatch, releaseProviderDispatchClaim, classifyPaymentTransportError } = require('./providerDispatchClaimService');

const ORDER_STATUSES = new Set(['queued', 'assigned', 'executing', 'verifying', 'review', 'success', 'failed', 'cancelled']);
const errorResult = (code, message) => ({ success: false, code, message });
const configuration = (bot = {}) => {
    if (!isExternalApiEnabled()) throw Object.assign(new Error('اتصال مزودي الخدمة متوقف.'), { code: 'EXTERNAL_API_DISABLED' });
    const decision = resolveProviderBaseUrl({ explicitUrl: bot.apiUrl || process.env.KENAN_API_URL || '' });
    if (decision.refused || !decision.baseUrl) throw Object.assign(new Error('أدخل رابط كنان الحالي في إعدادات المنفذ.'), { code: 'PROVIDER_URL_REFUSED' });
    let url;
    try { url = new URL(decision.baseUrl); } catch (_) { throw new Error('رابط كنان غير صالح.'); }
    if ((url.protocol !== 'https:' && !(isStagingRuntime() && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('رابط كنان يجب أن يكون HTTPS صالحاً.');
    const token = String(bot.apiToken || process.env.KENAN_API_KEY || '').trim().replace(/^Bearer\s+/i, '').trim();
    if (!token || /[\r\n]/.test(token)) throw new Error('مفتاح كنان مطلوب.');
    return { baseUrl: url.toString().replace(/\/+$/, ''), options: {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 15000, maxRedirects: 0, maxContentLength: 1024 * 1024, maxBodyLength: 8192
    } };
};
const validateTransfer = (phone, amount, transferType = 'vodafone') => {
    if (transferType !== 'vodafone' || !/^01[0125]\d{8}$/.test(String(phone || ''))) throw new Error('كنان يدعم أرقام المحافظ المصرية المكوّنة من 11 رقماً.');
    if (!Number.isSafeInteger(amount) || amount < 50 || amount > 60000) throw new Error('مبلغ كنان يجب أن يكون جنيهاً صحيحاً من 50 إلى 60000.');
    // Contract v7 accepts integer pounds only. Minor units belong to responses.
    return { phone: String(phone), amount };
};
const parseOrder = (data, expected = {}) => {
    if (!data || typeof data.reference !== 'string' || !/^\d{1,64}$/.test(data.reference)
        || !ORDER_STATUSES.has(data.status) || !/^01[0125]\d{8}$/.test(data.phone)
        || !Number.isSafeInteger(data.amount_minor) || data.amount_minor < 5000 || data.amount_minor > 6000000 || data.amount_minor % 100 !== 0
        || (expected.reference && data.reference !== expected.reference)
        || (expected.phone && data.phone !== expected.phone)
        || (expected.amount_minor && data.amount_minor !== expected.amount_minor)) throw new Error('رد كنان لا يطابق بيانات العملية.');
    const optional = (key, valid) => {
        if (data[key] === undefined || data[key] === null) return null;
        if (!valid(data[key])) throw new Error('INVALID_KENAN_RECEIPT');
        return data[key];
    };
    const minor = value => Number.isSafeInteger(value) && value >= 0;
    const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && value.length <= 64 && Number.isFinite(Date.parse(value));
    const result = { reference: data.reference, phone: data.phone, amount_minor: data.amount_minor, status: data.status,
        fee_minor: optional('fee_minor', minor), created_at: optional('created_at', date), completed_at: optional('completed_at', date),
        executor_phone: optional('executor_phone', value => typeof value === 'string' && /^01[0125]\d{8}$/.test(value)),
        customer_service_phone: optional('customer_service_phone', value => typeof value === 'string' && /^\+?\d{8,15}$/.test(value)),
        balance_before_minor: optional('balance_before_minor', minor), deducted_minor: optional('deducted_minor', minor),
        balance_after_minor: optional('balance_after_minor', minor), reason: optional('reason', value => typeof value === 'string' && value.length <= 1000) };
    if ([result.balance_before_minor, result.deducted_minor, result.balance_after_minor].every(value => value !== null)
        && result.balance_before_minor - result.deducted_minor !== result.balance_after_minor) throw new Error('INVALID_KENAN_BALANCE_RECEIPT');
    return result;
};
const safeFailure = error => {
    const status = Number(error.response?.status);
    const messages = { 400: 'رفض كنان صيغة بيانات التحويل.', 401: 'مفتاح كنان غير صالح أو موقوف.',
        404: 'رابط كنان أو مرجع العملية غير موجود.', 409: 'رصيد كنان المتاح لا يغطي الطلب.',
        429: 'مهلة كنان لمنع تكرار التحويل ما زالت سارية. راجع الطلب السابق قبل إعادة المحاولة.' };
    const result = errorResult(error.code === 'EXTERNAL_API_DISABLED' ? error.code : 'KENAN_REQUEST_FAILED', messages[status] || 'تعذر الاتصال بكنان. راجع الرابط والمفتاح وحالة المزود.');
    const retry = Number(error.response?.data?.retry_after_seconds || error.response?.headers?.['retry-after']);
    if (status === 429 && Number.isSafeInteger(retry) && retry > 0 && retry <= 86400) result.retryAfterSeconds = retry;
    return result;
};

const getBalance = async bot => {
    try {
        const config = configuration(bot);
        const { data } = await axios.get(`${config.baseUrl}/api/company/balance`, config.options);
        if (!data || !['credit', 'reserved', 'available'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0)
            || data.credit - data.reserved !== data.available) throw new Error('INVALID_BALANCE');
        return { success: true, serviceCredit: data.credit / 100, cashCredit: 0, reservedBalance: data.reserved / 100,
            availableBalance: data.available / 100, currency: 'EGP', message: 'تم الاتصال بكنان وقراءة الرصيد.' };
    } catch (error) { return safeFailure(error); }
};
const preflight = async (bot, input = {}) => {
    let config, payload;
    try { config = configuration(bot); payload = validateTransfer(input.phone || input.targetNumber, Number(input.amount)); }
    catch (_) { return errorResult('KENAN_INVALID_CONFIGURATION', 'راجع رابط كنان ومفتاحه ورقم المحفظة ومبلغاً صحيحاً من 50 إلى 60000 جنيه.'); }
    const balance = await getBalance(bot);
    if (!balance.success) return balance;
    try {
        const { data } = await axios.post(`${config.baseUrl}/api/company/orders/check`, payload, config.options);
        if (!data || data.eligible !== true || data.phone !== payload.phone || data.amount_minor !== payload.amount * 100
            || !Number.isSafeInteger(data.available_minor) || data.available_minor < data.amount_minor) {
            return errorResult('KENAN_ELIGIBILITY_UNCONFIRMED', 'لم يؤكد كنان أهلية الرقم والمبلغ والرصيد. لم يُنشأ تحويل أو يُحجز رصيد.');
        }
        return { ...balance, success: true, stage: 'completed', availableBalance: data.available_minor / 100,
            checks: [{ key: 'balance', label: 'اتصال كنان والرصيد', status: 'success', message: 'تمت قراءة الرصيد من كنان.' },
                { key: 'inquiry', label: 'فحص أهلية التحويل لدى كنان', status: 'success', message: 'أكد كنان أهلية الرقم والمبلغ دون إنشاء تحويل أو حجز رصيد.' }],
            message: 'أكد كنان أهلية التحويل. لم يُرسل تحويل مالي ولم يُحجز رصيد.' };
    } catch (error) { return safeFailure(error); }
};

const executeTransfer = async (tx, bot) => {
    let claim;
    try {
        const config = configuration(bot);
        const payload = validateTransfer(tx.vodafoneNumber || tx.accountNumber, Number(tx.amount), tx.transferType);
        claim = await claimProviderDispatch(tx);
        if (!claim.claimed) return { success: 'unresolved', code: UNRESOLVED_CODE, message: 'توجد مطالبة إرسال سابقة. راجع العملية قبل إعادة المحاولة.' };
        let response;
        try { response = await axios.post(`${config.baseUrl}/api/company/orders`, payload, config.options); }
        catch (error) {
            const classification = classifyPaymentTransportError(error);
            if (classification === 'before_send' || (classification === 'definitive_rejection' && [400, 401, 404, 409, 429].includes(Number(error.response?.status)))) {
                await releaseProviderDispatchClaim(tx, claim.attemptId);
                return { ...safeFailure(error), dispatchReleased: true };
            }
            throw error;
        }
        const order = parseOrder(response.data, { phone: payload.phone, amount_minor: payload.amount * 100 });
        const data = {
            kenanReference: order.reference, kenanProviderStatus: order.status, kenanOrder: order,
            kenanLastCheckedAt: new Date(), kenanAwaitingStatus: true,
            kenanNextPollAt: new Date(Date.now() + 5000), referenceNumber: order.reference,
            providerTransactionId: order.reference, externalTransactionId: order.reference,
            providerResultUnresolved: true, providerDispatchResult: 'kenan_pending', waitingApiAutoCompletion: false
        };
        const set = Object.fromEntries(Object.entries(data).map(([key, value]) => [`apiResultData.${key}`, value]));
        // Persist the reference before the queue performs any further I/O.
        const write = await Transaction.updateOne({ _id: tx._id, status: 'processing', executorGroupId: tx.executorGroupId,
            'apiResultData.providerDispatchAttemptId': claim.attemptId }, { $set: set }, { writeConcern: { w: 'majority' } });
        if (write.matchedCount !== 1) throw new Error('DISPATCH_STATE_CHANGED');
        tx.apiResultData = { ...(tx.apiResultData || {}), ...data };
        return { success: 'pending', providerPending: true, provider_transaction_id: order.reference, external_transaction_id: order.reference,
            reference_number: order.reference, dispatchAttemptId: claim.attemptId, message: 'استلم كنان الطلب. جارٍ متابعة النتيجة النهائية.' };
    } catch (error) {
        if (claim?.claimed) return { success: 'unresolved', code: UNRESOLVED_CODE, dispatchAttemptId: claim.attemptId,
            message: 'نتيجة إرسال كنان غير محسومة. راجع سجل المزود قبل إعادة الإرسال.' };
        return errorResult('KENAN_INVALID_CONFIGURATION', 'راجع إعدادات كنان ورقم المحفظة ومبلغاً صحيحاً من 50 إلى 60000 جنيه.');
    }
};

const getTransactions = async (bot, references = []) => {
    const operations = [];
    try {
        const config = configuration(bot);
        for (const reference of [...new Set(references.map(String))].slice(0, 100)) {
            if (!/^\d{1,64}$/.test(reference)) { operations.push({ success: false, requestedTransactionId: reference }); continue; }
            try {
                const { data } = await axios.get(`${config.baseUrl}/api/company/orders/${encodeURIComponent(reference)}`, config.options);
                const order = parseOrder(data, { reference });
                operations.push({ success: true, providerTransactionId: order.reference, requestedTransactionId: reference,
                    referenceNumber: order.reference, providerStatus: order.status, phone: order.phone, amount: order.amount_minor / 100,
                    providerDate: order.created_at, isReturned: ['failed', 'cancelled'].includes(order.status), rawData: order });
            } catch (_) { operations.push({ success: false, requestedTransactionId: reference, message: 'تعذر التحقق من عملية كنان.' }); }
        }
        return { success: operations.some(item => item.success), operations, checkedCount: operations.length, failedCount: operations.filter(item => !item.success).length };
    } catch (error) { return { ...safeFailure(error), operations: [], checkedCount: 0, failedCount: 0 }; }
};

const getLatestOrders = async bot => {
    try {
        const config = configuration(bot);
        const { data } = await axios.get(`${config.baseUrl}/api/company/orders`, config.options);
        const rows = Array.isArray(data) ? data : data?.orders;
        if (!Array.isArray(rows) || rows.length > 100) throw new Error('INVALID_KENAN_ORDERS');
        return { success: true, orders: rows.map(row => parseOrder(row)) };
    } catch (error) { return { ...safeFailure(error), orders: [] }; }
};
const getDeposits = async bot => {
    try {
        const config = configuration(bot);
        const { data } = await axios.get(`${config.baseUrl}/api/company/deposits`, config.options);
        const rows = Array.isArray(data) ? data : data?.deposits;
        if (!Array.isArray(rows) || rows.length > 1000) throw new Error('INVALID_KENAN_DEPOSITS');
        const deposits = rows.map(row => {
            if (!Number.isSafeInteger(row.amount_minor) || row.amount_minor < 0
                || typeof row.reference !== 'string' || row.reference.length > 128) throw new Error('INVALID_KENAN_DEPOSIT');
            return { reference: row.reference, amount_minor: row.amount_minor,
                created_at: typeof row.created_at === 'string' ? row.created_at.slice(0, 64) : null,
                responsible: typeof row.responsible === 'string' ? row.responsible.slice(0, 160) : null };
        });
        return { success: true, deposits };
    } catch (error) { return { ...safeFailure(error), deposits: [] }; }
};

const pollPendingOrders = async () => {
    if (!isKenanFollowupEnabled()) return;
    const now = new Date();
    const due = { status: 'processing',
        'apiResultData.kenanReference': { $exists: true, $nin: [null, ''] },
        'apiResultData.providerResultUnresolved': true, 'apiResultData.providerResolutionOutcome': { $exists: false },
        'apiResultData.kenanNextPollAt': { $lte: now } };
    const transactions = await Transaction.find(due).sort({ 'apiResultData.kenanNextPollAt': 1 }).limit(20);
    for (const tx of transactions) {
        // A persisted lease also prevents overlapping scans across server workers.
        const filter = { ...due, _id: tx._id, executorGroupId: tx.executorGroupId,
            'apiResultData.kenanReference': tx.apiResultData.kenanReference,
            'apiResultData.providerDispatchAttemptId': tx.apiResultData.providerDispatchAttemptId };
        const claimed = await Transaction.findOneAndUpdate(filter,
            { $set: { 'apiResultData.kenanNextPollAt': new Date(Date.now() + 60000) } }, { returnDocument: 'after' });
        if (!claimed) continue;
        const bot = await ExecutorGroup.findById(tx.executorGroupId);
        if (!bot || bot.apiProviderKey !== 'kenan') continue;
        const response = await getTransactions(bot, [claimed.apiResultData.kenanReference]);
        const operation = response.operations?.[0];
        if (!operation?.success || operation.phone !== claimed.vodafoneNumber
            || operation.amount !== Number(claimed.amount)) continue;
        const set = { 'apiResultData.kenanProviderStatus': operation.providerStatus,
            'apiResultData.kenanOrder': operation.rawData,
            'apiResultData.kenanFeeMinor': operation.rawData.fee_minor,
            'apiResultData.kenanLastCheckedAt': new Date() };
        const stateFilter = { _id: claimed._id, status: 'processing', executorGroupId: claimed.executorGroupId,
            'apiResultData.kenanReference': operation.providerTransactionId,
            updatedAt: claimed.updatedAt, 'apiResultData.providerResultUnresolved': true,
            'apiResultData.providerResolutionOutcome': { $exists: false } };
        if (operation.providerStatus === 'success') {
            Object.assign(set, { 'apiResultData.kenanAwaitingStatus': false,
                'apiResultData.providerResultUnresolved': false, 'apiResultData.providerDispatchResult': 'accepted',
                'apiResultData.referenceNumber': operation.referenceNumber,
                'apiResultData.waitingApiAutoCompletion': true, 'apiResultData.autoCompleteAt': new Date(),
                executorSenderPhone: operation.rawData.executor_phone || operation.referenceNumber });
            // The common completion monitor atomically posts the ledger and saves
            // completion. A crash here leaves a durable, recoverable waiting row.
            await Transaction.updateOne(stateFilter, { $set: set }, { writeConcern: { w: 'majority' } });
        } else if (['failed', 'cancelled'].includes(operation.providerStatus)) {
            Object.assign(set, { status: 'pending',
                'apiResultData.kenanAwaitingStatus': false, 'apiResultData.providerResultUnresolved': false,
                'apiResultData.providerDispatchResult': 'rejected', 'apiResultData.waitingApiAutoCompletion': false,
                adminNotes: [claimed.adminNotes, `[كنان: ${operation.providerStatus} | المرجع: ${operation.referenceNumber} | أُعيد الطلب للإدارة]`].filter(Boolean).join('\n') });
            await Transaction.updateOne(stateFilter, { $set: set, $unset: { executorGroupId: '', managerGroupId: '', executorName: '',
                'apiResultData.providerDispatchStartedAt': '', 'apiResultData.providerDispatchAttemptId': '',
                'apiResultData.providerDispatchExecutorGroupId': '' } }, { writeConcern: { w: 'majority' } });
        } else {
            set['apiResultData.kenanAwaitingStatus'] = true;
            set['apiResultData.providerDispatchResult'] = 'kenan_pending';
            set['apiResultData.kenanNextPollAt'] = new Date(Date.now() + 5000);
            await Transaction.updateOne(stateFilter, { $set: set });
        }
    }
};

module.exports = { getBalance, preflight, executeTransfer, getTransactions, getLatestOrders, getDeposits, parseOrder, pollPendingOrders };
