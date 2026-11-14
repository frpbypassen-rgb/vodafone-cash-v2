'use strict';

const axios = require('axios');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const { isExternalApiEnabled, isFinancialSchedulersEnabled, resolveProviderBaseUrl, isStagingRuntime } = require('../utils/runtimeControls');
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
    const token = String(bot.apiToken || process.env.KENAN_API_KEY || '').replace(/^Bearer\s+/i, '').trim();
    if (!token || /[\r\n]/.test(token)) throw new Error('مفتاح كنان مطلوب.');
    return { baseUrl: url.toString().replace(/\/+$/, ''), options: {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 15000, maxRedirects: 0, maxContentLength: 1024 * 1024, maxBodyLength: 8192
    } };
};
const validateTransfer = (phone, amount, transferType = 'vodafone') => {
    if (transferType !== 'vodafone' || !/^01[0125]\d{8}$/.test(String(phone || ''))) throw new Error('كنان يدعم أرقام المحافظ المصرية المكوّنة من 11 رقماً.');
    if (!Number.isSafeInteger(amount) || amount < 50 || amount > 60000) throw new Error('مبلغ كنان يجب أن يكون جنيهاً صحيحاً من 50 إلى 60000.');
    return { phone: String(phone), amount_minor: amount * 100 };
};
const parseOrder = (data, expected = {}) => {
    if (!data || typeof data.reference !== 'string' || !/^\d{1,64}$/.test(data.reference)
        || !ORDER_STATUSES.has(data.status) || !/^01[0125]\d{8}$/.test(data.phone)
        || !Number.isSafeInteger(data.amount_minor) || data.amount_minor < 5000 || data.amount_minor > 6000000 || data.amount_minor % 100 !== 0
        || (expected.reference && data.reference !== expected.reference)
        || (expected.phone && data.phone !== expected.phone)
        || (expected.amount_minor && data.amount_minor !== expected.amount_minor)) throw new Error('رد كنان لا يطابق بيانات العملية.');
    return { reference: data.reference, phone: data.phone, amount_minor: data.amount_minor, status: data.status,
        fee_minor: Number.isSafeInteger(data.fee_minor) && data.fee_minor >= 0 ? data.fee_minor : null,
        created_at: typeof data.created_at === 'string' ? data.created_at.slice(0, 64) : null };
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
    try { configuration(bot); validateTransfer(input.phone || input.targetNumber, Number(input.amount)); }
    catch (_) { return errorResult('KENAN_INVALID_CONFIGURATION', 'راجع رابط كنان ومفتاحه ورقم المحفظة ومبلغاً صحيحاً من 50 إلى 60000 جنيه.'); }
    const balance = await getBalance(bot);
    if (!balance.success) return balance;
    return { ...balance, success: balance.availableBalance >= Number(input.amount), stage: 'completed',
        checks: [{ key: 'balance', label: 'اتصال كنان والرصيد', status: balance.availableBalance >= Number(input.amount) ? 'success' : 'failed', message: 'التحقق من الرقم والمبلغ محلي. كنان لا يوفر استعلام تحويل منفصلاً.' }],
        message: balance.availableBalance >= Number(input.amount) ? 'نجح الاتصال وفحص الرصيد والبيانات محلياً.' : 'رصيد كنان المتاح لا يغطي المبلغ.' };
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
        const order = parseOrder(response.data, payload);
        const data = {
            kenanReference: order.reference, kenanProviderStatus: order.status, kenanAwaitingStatus: true,
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

const pollPendingOrders = async () => {
    if (!isExternalApiEnabled() || !isFinancialSchedulersEnabled()) return;
    const now = new Date();
    const due = { status: 'processing', 'apiResultData.kenanAwaitingStatus': true,
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
            'apiResultData.kenanFeeMinor': operation.rawData.fee_minor,
            'apiResultData.kenanLastCheckedAt': new Date() };
        const stateFilter = { _id: claimed._id, status: 'processing', executorGroupId: claimed.executorGroupId,
            'apiResultData.kenanReference': operation.providerTransactionId,
            'apiResultData.kenanAwaitingStatus': true, 'apiResultData.providerResultUnresolved': true,
            'apiResultData.providerResolutionOutcome': { $exists: false },
            'apiResultData.providerDispatchResult': 'kenan_pending' };
        if (operation.providerStatus === 'success') {
            Object.assign(set, { 'apiResultData.kenanAwaitingStatus': false,
                'apiResultData.providerResultUnresolved': false, 'apiResultData.providerDispatchResult': 'accepted',
                'apiResultData.referenceNumber': operation.referenceNumber,
                'apiResultData.waitingApiAutoCompletion': true, 'apiResultData.autoCompleteAt': new Date(),
                executorSenderPhone: operation.referenceNumber });
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
            set['apiResultData.kenanNextPollAt'] = new Date(Date.now() + 5000);
            await Transaction.updateOne(stateFilter, { $set: set });
        }
    }
};

module.exports = { getBalance, preflight, executeTransfer, getTransactions, parseOrder, pollPendingOrders };
