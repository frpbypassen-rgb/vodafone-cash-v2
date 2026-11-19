// services/externalApiService.js
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { renderApiReceiptWithBrowser } = require('./apiReceiptBrowserService');
const { SYSTEM_TIME_ZONE } = require('../config/systemTime');
const { getApiProviderPreset } = require('../utils/apiProviderPresets');
const logger = require('../utils/logger');
const { getProviderAuthSession, invalidateProviderAuthSession, DEFAULT_PROVIDER_HEADERS } = require('./providerAuthSessionService');
const { classifyProviderPaymentResponse, normalizeProviderStatus, isReturnedProviderStatus } = require('../utils/providerPaymentResponse');
const {
    UNRESOLVED_CODE,
    claimProviderDispatch,
    saveZaynReply,
    releaseProviderDispatchClaim,
    classifyPaymentTransportError
} = require('./providerDispatchClaimService');
const {
    blockedProviderResult,
    EXTERNAL_API_DISABLED_MESSAGE,
    isExternalApiEnabled,
    resolveProviderBaseUrl
} = require('../utils/runtimeControls');

const { classifyZaynReceiptStatus } = require('../utils/zaynReceiptStatus');

const SUPPORT_PHONE = '01108172258';

const normalizeBaseUrl = (value) => {
    let baseUrl = String(value || '').trim().replace(/\/+$/, '');
    if (baseUrl && !baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
    return baseUrl;
};

const parseNumberOrDefault = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const numberOrZero = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

// The provider masks the beneficiary/reference phone when the payment is
// settled. A full number is an accepted-looking response that still needs a
// provider follow-up and an operator decision.
const isMaskedProviderReference = (value) => /[*＊×•·]/u.test(String(value || ''));

const extractProviderPhone = (data = {}) => {
    if (data.PhoneNumber) return String(data.PhoneNumber).trim();
    const details = Array.isArray(data.PrintServiceDetailes) ? data.PrintServiceDetailes : [];
    const phoneEntry = details.find((entry) => {
        const key = normalizeProviderStatus(entry && entry.Key);
        return key.includes('موبايل') || key.includes('هاتف') || key.includes('رقم المحمول');
    });
    return phoneEntry && phoneEntry.Value ? String(phoneEntry.Value).trim() : '';
};

const normalizeProviderTransaction = (data = {}, fallbackTransactionNumber = '') => ({
    reportedTransactionId: String(data.TransactionId || data.TransactionNumber || '').trim(),
    providerTransactionId: String(data.TransactionId || data.TransactionNumber || fallbackTransactionNumber || '').trim(),
    referenceNumber: String(data.RefNumber || data.PaymentServiceProviderTransactionId || '').trim(),
    providerStatus: String(data.TransactionStatus || '').trim(),
    amount: Number.isFinite(Number(data.Amount)) ? Number(data.Amount) : null,
    phone: extractProviderPhone(data),
    serviceName: String(data.ServiceName || '').trim(),
    providerDate: String(data.Date || '').trim(),
    providerTime: String(data.Time || '').trim(),
    isReturned: isReturnedProviderStatus(data.TransactionStatus),
    rawData: data
});

const formatAmount = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return String(value || '0');
    return parsed.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const explicitProviderUrl = (apiBot = {}, env = process.env) => [
    apiBot.apiUrl,
    env.ZAYN_AGGREGATOR_URL,
    env.ZAYNPAY_URL
].map((value) => String(value || '').trim()).find(Boolean) || '';

const resolveApiProviderConfig = (apiBot = {}, env = process.env) => {
    const preset = getApiProviderPreset(apiBot.apiProviderKey);
    const providerKey = String(apiBot.apiProviderKey || '').trim();
    const usesExactInquiryContract = providerKey === 'zayn_external_aggregator'
        || providerKey === 'zaynpay_legacy';
    const decision = resolveProviderBaseUrl({
        explicitUrl: explicitProviderUrl(apiBot, env),
        presetUrl: preset.apiUrl,
        env
    });
    const baseUrl = decision.refused ? '' : normalizeBaseUrl(decision.baseUrl);

    return {
        preset,
        baseUrl,
        providerUrlRefused: decision.refused,
        providerUrlRefusal: decision.reason,
        apiUsername: apiBot.apiUsername || process.env.ZAYN_USERNAME || process.env.ZAYNPAY_USERNAME,
        apiPassword: apiBot.apiPassword || process.env.ZAYN_PASSWORD || process.env.ZAYNPAY_PASSWORD,
        staticToken: (apiBot.apiToken || process.env.ZAYN_API_TOKEN || process.env.ZAYNPAY_API_TOKEN || '').replace(/^Bearer\s+/i, '').trim(),
        serviceId: usesExactInquiryContract
            ? preset.serviceId
            : parseNumberOrDefault(apiBot.apiServiceId || process.env.ZAYN_AGGREGATOR_SERVICE_ID || process.env.ZAYNPAY_SERVICE_ID, preset.serviceId),
        providerId: usesExactInquiryContract
            ? preset.providerId
            : parseNumberOrDefault(apiBot.apiProviderId || process.env.ZAYN_AGGREGATOR_PROVIDER_ID || process.env.ZAYNPAY_PROVIDER_ID, preset.providerId),
        // The provider identifies the input by its string key (for example
        // `Key1`), not by the legacy numeric field id.
        fieldKey: usesExactInquiryContract
            ? preset.fieldKey
            : String(
                apiBot.apiFieldKey
                || (apiBot.apiFieldId != null ? `Key${apiBot.apiFieldId}` : '')
                || process.env.ZAYN_AGGREGATOR_FIELD_KEY
                || process.env.ZAYNPAY_FIELD_KEY
                || preset.fieldKey
                || 'Key1'
            ).trim(),
        machineSerial: usesExactInquiryContract
            ? preset.machineSerial
            : (apiBot.apiMachineSerial || process.env.ZAYN_AGGREGATOR_MACHINE_SERIAL || process.env.ZAYNPAY_MACHINE_SERIAL || preset.machineSerial),
        defaultHeaders: { ...DEFAULT_PROVIDER_HEADERS }
    };
};

const providerCallBlock = (env = process.env) => {
    if (!isExternalApiEnabled(env)) return blockedProviderResult('EXTERNAL_API_DISABLED', EXTERNAL_API_DISABLED_MESSAGE);
    return null;
};

const refuseResolvedProvider = (config) => {
    if (config && config.providerUrlRefused) {
        return blockedProviderResult('PROVIDER_URL_REFUSED', `PROVIDER_URL_REFUSED: ${config.providerUrlRefusal || 'PROVIDER_URL_REFUSED'}`);
    }
    return null;
};

const readRetryAfterSeconds = response => {
    const header = String(response?.headers?.['retry-after'] ?? '').trim();
    const date = Date.parse(header);
    let retryAfterSeconds = null;
    if (/^\d{1,9}$/.test(header)) retryAfterSeconds = Number(header);
    else if (Number.isFinite(date) && new Date(date).toUTCString() === header) {
        retryAfterSeconds = Math.max(0, Math.ceil((date - Date.now()) / 1000));
    }
    return retryAfterSeconds;
};
const logPreflightAuthFailure = (response) => {
    const status = response?.status;
    const code = String(response?.data?.Code ?? '');
    const retryAfterSeconds = readRetryAfterSeconds(response);
    logger.warn('PROVIDER_PREFLIGHT_AUTH_FAILED', {
        providerHttpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
        providerCode: /^\d{1,9}$/.test(code) ? Number(code) : null,
        retryAfterSeconds
    });
};

const authorizeApiProvider = async (config, addLog, onRejected) => {
    const blocked = providerCallBlock() || refuseResolvedProvider(config);
    if (blocked) {
        addLog(blocked.code, blocked.message);
        return { success: false, message: blocked.message, code: blocked.code };
    }
    let freshToken = config.staticToken;
    if (!freshToken && (!config.apiUsername || !config.apiPassword)) {
        addLog('AUTH_ERROR', 'بيانات مزود API غير مكتملة');
        return { success: false, message: 'خطأ إعدادات: بيانات الاتصال مفقودة' };
    }
    if (!freshToken) {
        let session;
        try {
            session = await getProviderAuthSession(config, {
                onLogin: () => addLog('AUTH', 'جاري إرسال طلب تسجيل الدخول...'), onRejected
            });
        } catch (error) {
            addLog('AUTH_FAILURE', `HTTP=${error.providerHttpStatus ?? 'unknown'} | providerCode=${error.providerCode ?? 'unknown'} | cooldown=${error.retryAfterSource || 'unknown'}`);
            throw error;
        }
        freshToken = session.token;
        addLog(session.cached ? 'AUTH_CACHE' : 'AUTH_SUCCESS', session.cached ? 'تم استخدام جلسة المزود الصالحة دون تسجيل دخول جديد' : 'تم استلام التوكن بنجاح');
    } else addLog('AUTH_TOKEN', 'تم استخدام التوكن المحفوظ في إعدادات المنفذ');

    return {
        success: true,
        headers: { ...config.defaultHeaders, 'Authorization': `Bearer ${freshToken}`, 'Accept-Language': 'ar-EG' }
    };
};

// Retry reads only. The Payment POST deliberately never goes through this helper.
const postProviderRead = async (config, headers, endpoint, payload, addLog) => {
    for (let attempt = 0; attempt < 2; attempt++) {
        const blocked = providerCallBlock() || refuseResolvedProvider(config);
        if (blocked) throw Object.assign(new Error(blocked.message), { code: blocked.code });
        let response;
        try {
            response = await axios.post(config.baseUrl + endpoint, payload, { headers, timeout: 20000, maxRedirects: 0 });
            if (Number(response.data?.Code) !== 401) return response;
        } catch (error) {
            if (Number(error.response?.status) !== 401) throw error;
            if (attempt || config.staticToken) { invalidateProviderAuthSession(config, headers.Authorization); throw error; }
        }
        invalidateProviderAuthSession(config, headers.Authorization);
        if (attempt || config.staticToken) return response;
        addLog('AUTH_REFRESH', 'انتهت جلسة المزود؛ تجديد واحد للاستعلام فقط');
        const refreshed = await authorizeApiProvider(config, addLog);
        if (!refreshed.success) throw Object.assign(new Error(refreshed.message), { code: refreshed.code });
        Object.assign(headers, refreshed.headers);
    }
};

// 🚀 دالة التخاطب مع شركة زين
const normalizeApiTargetNumber = (value) => String(value || '')
    .trim()
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[^0-9]/g, '');

const providerMessage = (data, fallback) => {
    if (data && typeof data === 'object') {
        return String(data.Message || data.message || data.error || fallback || '').trim();
    }
    return String(fallback || '').trim();
};

const errorMessage = (error, fallback) => providerMessage(error?.response?.data, error?.message || fallback);

const authFailureDetails = error => String(error.code || '').startsWith('PROVIDER_AUTH_')
    ? { code: error.code, retryAfterSeconds: error.retryAfterSeconds, retryAfterSource: error.retryAfterSource,
        providerHttpStatus: error.providerHttpStatus, providerCode: error.providerCode } : {};

const hasSuccessCode = (data) => Number(data?.Code) === 200;

const firstNonEmpty = (...values) => {
    for (const value of values) {
        const clean = ['number','string'].includes(typeof value) ? String(value).trim() : '';
        if (clean && clean.length <= 128 && !/[\u0000-\u001f\u007f]/.test(clean)) return clean;
    }
    return '';
};

const getApiConfigurationIssues = (config) => {
    const issues = [];
    if (!config.baseUrl) issues.push('رابط مزود الخدمة غير موجود');
    if (!config.staticToken && (!config.apiUsername || !config.apiPassword)) {
        issues.push('بيانات دخول API غير مكتملة');
    }
    if (!Number.isFinite(Number(config.serviceId)) || Number(config.serviceId) <= 0) issues.push('رقم الخدمة غير صالح');
    if (!Number.isFinite(Number(config.providerId)) || Number(config.providerId) <= 0) issues.push('رقم مزود الخدمة غير صالح');
    if (!String(config.fieldKey || '').trim()) issues.push('مفتاح حقل الخدمة غير موجود');
    if (!String(config.machineSerial || '').trim()) issues.push('الرقم التسلسلي للجهاز غير موجود');
    return issues;
};

const buildInquiryPayload = (config, targetNumber, amount) => ({
    fields: [{ value: targetNumber, key: config.fieldKey }],
    serviceId: config.serviceId,
    currentServiceProviderId: config.providerId,
    inqueryAmount: amount,
    machineSerial: config.machineSerial
});

const getApiProviderBalanceWithAuth = async (config, headers, addLog) => {
    const blocked = providerCallBlock() || refuseResolvedProvider(config);
    if (blocked) return { success: false, message: blocked.message, code: blocked.code };
    addLog('BALANCE', 'Checking available provider balance');
    const balanceRes = await postProviderRead(config, headers, '/api/Account/GetBalance', {}, addLog);
    const responseData = balanceRes.data || {};
    const rawBalance = responseData.Data || {};

    if (!hasSuccessCode(responseData) || !responseData.Data) {
        const message = providerMessage(responseData, 'تم رفض استعلام رصيد المزود');
        addLog('BALANCE_FAIL', message || 'Unexpected provider response');
        return { success: false, message };
    }

    const numericBalance = value => value !== null && value !== undefined && value !== ''
        && ['number', 'string'].includes(typeof value) && Number.isFinite(Number(value));
    const fields = ['ServiceCredit', 'CashCredit', 'AvailableBalance', 'Balance'];
    if (!fields.some(key => numericBalance(rawBalance[key])) || fields.some(key => rawBalance[key] != null && !numericBalance(rawBalance[key]))) {
        return { success: false, message: 'رد رصيد المزود ناقص أو غير صالح.' };
    }
    const serviceCredit = numberOrZero(rawBalance.ServiceCredit);
    const cashCredit = numberOrZero(rawBalance.CashCredit);
    const availableBalance = numberOrZero(rawBalance.AvailableBalance ?? rawBalance.Balance ?? (serviceCredit + cashCredit));
    addLog('BALANCE_SUCCESS', `ServiceCredit=${serviceCredit} | CashCredit=${cashCredit} | Available=${availableBalance}`);

    return {
        success: true,
        message: providerMessage(responseData, 'تم استعلام رصيد المزود بنجاح'),
        serviceCredit,
        cashCredit,
        availableBalance,
        balance: availableBalance,
        rawData: rawBalance
    };
};

// Validates the exact inquiry request used for a real transfer without calling Payment.
const runApiTransferPreflight = async (apiBot, input = {}) => {
    if (apiBot?.apiProviderKey === 'kenan') return require('./kenanProviderService').preflight(apiBot, input);
    const blocked = providerCallBlock();
    if (blocked) return blocked;
    const processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { timeZone: SYSTEM_TIME_ZONE, hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };
    const checks = [];
    let stage = 'configuration';

    try {
        const config = resolveApiProviderConfig(apiBot || {});
        const refused = refuseResolvedProvider(config);
        if (refused) return { ...refused, processLog: processLog.join('\n') };
        const targetNumber = normalizeApiTargetNumber(input.phone || input.targetNumber);
        const amount = Number(input.amount);
        const configurationIssues = getApiConfigurationIssues(config);

        if (!targetNumber || targetNumber.length < 5 || targetNumber.length > 20) {
            configurationIssues.push('رقم العميل المستخدم للاختبار غير صالح');
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            configurationIssues.push('قيمة الاختبار يجب أن تكون أكبر من صفر');
        }

        if (configurationIssues.length) {
            const message = configurationIssues.join(', ');
            addLog('CONFIG_FAIL', message);
            checks.push({ key: 'configuration', label: 'إعدادات التحويل', status: 'failed', message });
            return { success: false, stage, message, checks, processLog: processLog.join('\n') };
        }

        addLog('CONFIG_SUCCESS', `${config.preset.name} | serviceId=${config.serviceId} | currentServiceProviderId=${config.providerId} | fieldKey=${config.fieldKey}`);
        checks.push({ key: 'configuration', label: 'إعدادات الخدمة', status: 'success', message: 'البيانات الأساسية مكتملة' });

        stage = 'authentication';
        const auth = await authorizeApiProvider(config, addLog, logPreflightAuthFailure);
        if (!auth.success) {
            checks.push({ key: 'authentication', label: 'تسجيل الدخول للمزود', status: 'failed', message: auth.message });
            return { success: false, stage, message: auth.message, checks, processLog: processLog.join('\n') };
        }
        checks.push({ key: 'authentication', label: 'تسجيل الدخول للمزود', status: 'success', message: 'تمت المصادقة بنجاح' });

        stage = 'balance';
        const balance = await getApiProviderBalanceWithAuth(config, auth.headers, addLog);
        if (!balance.success) {
            checks.push({ key: 'balance', label: 'رصيد المزود', status: 'failed', message: balance.message });
            return { success: false, stage, message: balance.message, checks, processLog: processLog.join('\n') };
        }
        checks.push({
            key: 'balance',
            label: 'رصيد المزود',
            status: balance.availableBalance < amount ? 'warning' : 'success',
            message: `الرصيد المتاح: ${balance.availableBalance}`
        });

        stage = 'inquiry';
        addLog('INQUIRY_TEST', `Safe test for [${targetNumber}] amount [${amount}] without payment.`);
        const inquiryRes = await postProviderRead(config, auth.headers, '/api/V1/Transactions/Inquiry', buildInquiryPayload(config, targetNumber, amount), addLog);
        const inquiryData = inquiryRes.data || {};
        const paymentBillInfo = inquiryData.Data?.PaymentBillInfo;
        if (!hasSuccessCode(inquiryData) || !paymentBillInfo) {
            const message = providerMessage(inquiryData, 'تم رفض الاستعلام عن التحويل من المزود');
            addLog('INQUIRY_FAIL', message);
            checks.push({ key: 'inquiry', label: 'فحص بيانات التحويل', status: 'failed', message });
            return { success: false, stage, message, checks, processLog: processLog.join('\n') };
        }

        addLog('INQUIRY_SUCCESS', 'Provider accepted transfer data; no payment was submitted.');
        checks.push({ key: 'inquiry', label: 'فحص بيانات التحويل', status: 'success', message: 'تم قبول رقم العميل والقيمة لدى المزود' });
        return {
            success: true,
            stage: 'completed',
            message: 'المنفذ جاهز للتحويل: نجح الاتصال والرصيد والاستعلام الفعلي دون إرسال أي دفعة.',
            checks,
            targetNumber,
            amount,
            serviceCredit: balance.serviceCredit,
            cashCredit: balance.cashCredit,
            availableBalance: balance.availableBalance,
            processLog: processLog.join('\n')
        };
    } catch (error) {
        if (stage === 'authentication') logPreflightAuthFailure(error?.response);
        const message = errorMessage(error, 'تعذر الاتصال بالمزود أثناء اختبار التحويل');
        addLog(`${String(stage || 'system').toUpperCase()}_ERROR`, message);
        checks.push({ key: stage, label: 'اتصال مزود الخدمة', status: 'failed', message });
        return { success: false, stage, message, checks, processLog: processLog.join('\n') };
    }
};

const executeTransferViaApi = async (tx, apiBot) => {
    const blocked = providerCallBlock();
    if (blocked) return blocked;
    if (apiBot?.apiProviderKey === 'kenan') return require('./kenanProviderService').executeTransfer(tx, apiBot);
    let preflightStage = 'configuration';
    const processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { timeZone: SYSTEM_TIME_ZONE, hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };

    try {
        const targetNumber = normalizeApiTargetNumber(tx.vodafoneNumber || tx.accountNumber || tx.serviceDetails?.clientPhone);
        const amount = Number(tx.amount);
        const config = resolveApiProviderConfig(apiBot || {});
        const refused = refuseResolvedProvider(config);
        if (refused) return refused;
        const { preset, baseUrl, serviceId, providerId, fieldKey, machineSerial } = config;
        const configurationIssues = getApiConfigurationIssues(config);
        if (!targetNumber || targetNumber.length < 5 || targetNumber.length > 20) {
            configurationIssues.push('رقم العميل غير صالح للتحويل عبر API');
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            configurationIssues.push('قيمة التحويل غير صالحة');
        }
        if (configurationIssues.length) {
            const message = configurationIssues.join(', ');
            addLog('CONFIG_FAIL', message);
            return { success: false, message, preflightStage, processLog: processLog.join('\n') };
        }
        preflightStage = 'auth';
        const auth = await authorizeApiProvider(config, addLog);
        if (!auth.success) {
            return { success: false, message: auth.message, preflightStage, processLog: processLog.join('\n') };
        }
        preflightStage = 'inquiry';
        const headers = auth.headers;
        
        addLog("PROVIDER", `${preset.name} | serviceId=${serviceId} | currentServiceProviderId=${providerId} | fieldKey=${fieldKey}`);
        addLog("INQUIRY", 'جارٍ فحص أهلية المحفظة والمبلغ.');
        const inquiryPayload = buildInquiryPayload(config, targetNumber, amount);
        const inquiryRes = await postProviderRead(config, headers, '/api/V1/Transactions/Inquiry', inquiryPayload, addLog);
        const inquiryData = inquiryRes.data || {};

        if (!hasSuccessCode(inquiryData) || !inquiryData.Data || !inquiryData.Data.PaymentBillInfo) {
            const message = 'رفض المزود استعلام الأهلية أو أعاد ردًا ناقصًا.';
            addLog("INQUIRY_FAIL", message);
            return { success: false, message, preflightStage, providerHttpStatus:inquiryRes.status || null, processLog: processLog.join('\n') };
        }
        
        addLog("INQUIRY_SUCCESS", "الرقم سليم ومتاح للتحويل.");
        addLog("PAYMENT", `جاري إرسال الدفعة النهائية بقيمة [${amount} EGP]...`);

        const claim = await claimProviderDispatch(tx, { zaynFollowup:true });
        if (!claim.claimed) {
            addLog('PAYMENT_BLOCKED', 'لم تُرسل الدفعة: مطالبة الإرسال غير متاحة أو موجودة مسبقاً');
            return {
                success: 'unresolved',
                code: UNRESOLVED_CODE,
                message: 'نتيجة المزود غير محسومة: توجد مطالبة إرسال دون نتيجة نهائية',
                dispatchAttemptId: claim.attemptId || null,
                processLog: processLog.join('\n')
            };
        }

        const paymentPayload = {
            fields: [{ value: targetNumber, key: fieldKey }],
            serviceId,
            currentServiceProviderId: providerId,
            paymentBillInfo: inquiryData.Data.PaymentBillInfo,
            amount,
            machineSerial
        };
        let paymentRes;
        try {
            paymentRes = await axios.post(`${baseUrl}/api/V1/Transactions/Payment`, paymentPayload, { headers, timeout: 180000, maxRedirects: 0 });
        } catch (paymentError) {
            if (Number(paymentError.response?.status) === 401) invalidateProviderAuthSession(config, headers.Authorization);
            const message = 'تعذر تأكيد وصول الدفعة إلى مزود الخدمة.';
            addLog('SYSTEM_ERROR', message);
            const classification = classifyPaymentTransportError(paymentError);
            if (paymentError.response) await saveZaynReply(tx, claim.attemptId, {
                zaynPaymentReplyAt:new Date(), zaynPaymentReplyState:'unknown',
                zaynPaymentHttpStatus:paymentError.response.status || null
            });
            if (classification === 'before_send') {
                try {
                    await releaseProviderDispatchClaim(tx, claim.attemptId);
                } catch (releaseError) {
                    addLog('CLAIM_RELEASE_FAIL', releaseError.message);
                    return {
                        success: 'unresolved',
                        code: UNRESOLVED_CODE,
                        message,
                        dispatchAttemptId: claim.attemptId,
                        processLog: processLog.join('\n')
                    };
                }
                return { success: false, message, processLog: processLog.join('\n'), dispatchReleased: true };
            }
            return {
                success: 'unresolved',
                code: UNRESOLVED_CODE,
                message,
                dispatchAttemptId: claim.attemptId,
                processLog: processLog.join('\n')
            };
        }

        const paymentData = paymentRes.data || {};
        if (Number(paymentData.Code) === 401) invalidateProviderAuthSession(config, headers.Authorization);
        const pd = paymentData.Data || {};
        const print = pd.PrintBill || {};
        const extRef = firstNonEmpty(pd.TransactionNumber, pd.TransactionId, print.TransactionId);
        const refTxNum = firstNonEmpty(
            pd.RefTransactionNumber,
            pd.RefNumber,
            print.RefTransactionNumber,
            print.RefNumber,
            pd.ApprovalNumber
        );

        const echoedPhone = extractProviderPhone(pd);
        const mismatch = (pd.Amount != null && Number(pd.Amount) !== amount)
            || (echoedPhone && normalizeApiTargetNumber(echoedPhone) !== targetNumber);
        const paymentOutcome = mismatch ? 'unresolved' : classifyProviderPaymentResponse(paymentData, {
            returned: isReturnedProviderStatus(pd.Status || paymentData.Message)
        });
        const state = classifyZaynReceiptStatus(pd.TransactionStatus || pd.Status);
        const paidFlag = [true,1,'1','true'].includes(pd.IsPaid);
        const statusSupplied = Boolean(String(pd.TransactionStatus || pd.Status || '').trim());
        const settled = paymentOutcome === 'accepted' && isMaskedProviderReference(refTxNum)
            && (state === 'paid' || (!statusSupplied && paidFlag));
        const held = !settled && paymentOutcome !== 'rejected';
        const evidence = {
            zaynPaymentReplyAt:new Date(), zaynPaymentHttpStatus:paymentRes.status || null,
            zaynPaymentReplyState:settled ? 'accepted' : paymentOutcome === 'accepted' ? 'pending'
                : paymentOutcome === 'rejected' ? 'rejected' : 'unknown',
            zaynPaymentStatus:state, providerTransactionId:extRef || null, referenceNumber:refTxNum || null,
            externalTransactionId:extRef || null, referenceMasked:isMaskedProviderReference(refTxNum)
        };
        if (held) Object.assign(evidence, {
            providerResultUnresolved: true, providerDispatchResult: 'pending_reference',
            providerResultUnresolvedAt: evidence.zaynPaymentReplyAt, providerResultUnresolvedCode: UNRESOLVED_CODE
        });
        await saveZaynReply(tx, claim.attemptId, evidence);
        addLog('PAYMENT_REPLY', 'HTTP=' + (paymentRes.status || 'unknown') + ' | ' + evidence.zaynPaymentReplyState);
        if (paymentOutcome === 'accepted') {
            const result = {
                success:settled || 'pending', providerPending:!settled,
                provider_transaction_id:extRef || null, external_transaction_id:extRef || (settled ? refTxNum : null),
                reference_number:refTxNum || null, reference_masked:evidence.referenceMasked, dispatchAttemptId:claim.attemptId,
                status:state, processLog:processLog.join('\n')
            };
            if (!settled) return { ...result, message:extRef ? 'سُجل رقم عملية المزود وبانتظار تأكيد النتيجة.' : 'ردّ المزود دون رقم عملية يمكن الاستعلام به.' };
            return { ...result, message:'أكد المزود نجاح الدفع.',sender_number:refTxNum,
                balance_before:pd.BalanceBefore,balance_after:pd.BalanceAfter,transaction_time:pd.TransactionTime };
        } else {
            if (paymentOutcome !== 'rejected') {
                addLog('PAYMENT_UNRESOLVED', 'Provider reply does not establish a final payment outcome');
                return { success: 'unresolved', code: UNRESOLVED_CODE,
                    message: 'نتيجة المزود غير محسومة. يلزم التحقق قبل إعادة الدفع.',
                    dispatchAttemptId: claim.attemptId, processLog: processLog.join('\n') };
            }
            const message = 'رفض مزود الخدمة تنفيذ الدفعة.';
            addLog("PAYMENT_FAIL", message);
            try {
                await releaseProviderDispatchClaim(tx, claim.attemptId);
            } catch (releaseError) {
                addLog('CLAIM_RELEASE_FAIL', releaseError.message);
                return {
                    success: 'unresolved',
                    code: UNRESOLVED_CODE,
                    message,
                    dispatchAttemptId: claim.attemptId,
                    processLog: processLog.join('\n')
                };
            }
            return { success: false, message, processLog: processLog.join('\n'), dispatchReleased: true };
        }

    } catch (error) {
        const message = error.code?.startsWith('PROVIDER_AUTH_') ? error.message : 'تعذر التحقق من رد مزود الخدمة.';
        addLog("SYSTEM_ERROR", message);
        const attemptId = tx && tx.apiResultData && tx.apiResultData.providerDispatchAttemptId;
        if (attemptId) {
            return {
                success: 'unresolved',
                code: UNRESOLVED_CODE,
                message,
                dispatchAttemptId: attemptId,
                processLog: processLog.join('\n')
            };
        }
        return { success: false, message, preflightStage, providerHttpStatus:error.response?.status || null, ...authFailureDetails(error), processLog: processLog.join('\n') };
    }
};

const getApiProviderBalance = async (apiBot) => {
    const blocked = providerCallBlock();
    if (blocked) return blocked;
    if (apiBot?.apiProviderKey === 'kenan') return require('./kenanProviderService').getBalance(apiBot);
    const processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { timeZone: SYSTEM_TIME_ZONE, hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };

    try {
        const config = resolveApiProviderConfig(apiBot || {});
        const refused = refuseResolvedProvider(config);
        if (refused) return { ...refused, processLog: processLog.join('\n') };
        const auth = await authorizeApiProvider(config, addLog);
        if (!auth.success) {
            return { success: false, message: auth.message, code: auth.code, processLog: processLog.join('\n') };
        }

        const result = await getApiProviderBalanceWithAuth(config, auth.headers, addLog);
        return { ...result, processLog: processLog.join('\n') };
    } catch (error) {
        const message = errorMessage(error, 'خطأ في الاتصال بسيرفر مزود الخدمة');
        addLog("SYSTEM_ERROR", message);
        return { success: false, message, ...authFailureDetails(error), processLog: processLog.join('\n') };
    }
};

const getApiProviderTransactions = async (apiBot, transactionNumbers = []) => {
    const blocked = providerCallBlock();
    if (blocked) return blocked;
    if (apiBot?.apiProviderKey === 'kenan') return require('./kenanProviderService').getTransactions(apiBot, Array.isArray(transactionNumbers) ? transactionNumbers : [transactionNumbers]);
    const processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { timeZone: SYSTEM_TIME_ZONE, hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };
    const uniqueNumbers = [...new Set(
        (Array.isArray(transactionNumbers) ? transactionNumbers : [transactionNumbers])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
    )].slice(0, 100);

    if (!uniqueNumbers.length) {
        return { success: true, operations: [], processLog: '' };
    }

    try {
        const config = resolveApiProviderConfig(apiBot || {});
        const refused = refuseResolvedProvider(config);
        if (refused) return refused;
        const auth = await authorizeApiProvider(config, addLog);
        if (!auth.success) {
            return { success: false, message: auth.message, code: auth.code, operations: [], processLog: processLog.join('\n') };
        }

        const operations = [];
        for (const transactionNumber of uniqueNumbers) {
            try {
                const printRes = await postProviderRead(config, auth.headers, '/api/V1/Transactions/Print', { TransactionNumber: transactionNumber }, addLog);
                const responseData = printRes.data || {};
                if (!hasSuccessCode(responseData) || !responseData.Data) {
                    operations.push({
                        success: false,
                        providerTransactionId: transactionNumber,
                        requestedTransactionId: transactionNumber,
                        retryAfterSeconds:readRetryAfterSeconds(printRes),
                        message: 'تعذر استرجاع تفاصيل العملية من المزود'
                    });
                    continue;
                }

                operations.push({
                    success: true,
                    ...normalizeProviderTransaction(responseData.Data, transactionNumber),
                    requestedTransactionId: transactionNumber,
                    message: 'تمت قراءة إيصال العملية من المزود'
                });
            } catch (error) {
                const retryAfterSeconds = error.retryAfterSeconds ?? readRetryAfterSeconds(error.response);
                operations.push({
                    success: false,
                    providerTransactionId: transactionNumber,
                    requestedTransactionId: transactionNumber,
                    retryAfterSeconds, message:'تعذر الاتصال بمسار مراجعة العمليات'
                });
            }
        }

        const failedCount = operations.filter((operation) => !operation.success).length;
        addLog('TRANSACTION_REVIEW', `Checked=${operations.length} | Failed=${failedCount}`);
        return {
            success: failedCount < operations.length,
            operations,
            checkedCount: operations.length,
            failedCount,
            processLog: processLog.join('\n')
        };
    } catch (error) {
        const providerMessage = 'تعذر التحقق من جلسة المزود أو قراءة الإيصال.';
        addLog('SYSTEM_ERROR', providerMessage);
        return {
            success: false,
            message: providerMessage, retryAfterSeconds:error.retryAfterSeconds ?? readRetryAfterSeconds(error.response),
            operations: [],
            processLog: processLog.join('\n')
        };
    }
};

const getApiProviderTransaction = async (apiBot, transactionNumber) => {
    const result = await getApiProviderTransactions(apiBot, [transactionNumber]);
    if (!result.operations?.length) {
        return { success: false, message: result.message || 'العملية غير موجودة لدى المزود', retryAfterSeconds:result.retryAfterSeconds };
    }
    return result.operations[0];
};

// 🧾 صانع إيصالات الـ API الذكي
const generateCustomReceipt = async (tx, apiResult) => {
    return renderApiReceiptWithBrowser(async (browser) => {
        const page = await browser.newPage();
        await page.setViewport({ width: 520, height: 860 });
        
        const now = new Date();
        const dateStr = apiResult.transaction_time || now.toLocaleString('ar-LY-u-nu-latn', { timeZone: SYSTEM_TIME_ZONE, hour12: true });
        const targetNumber = tx.vodafoneNumber || tx.accountNumber || '---';
        const referenceNumber = apiResult.reference_number || apiResult.sender_number || '---';
        const providerTxId = apiResult.provider_transaction_id || apiResult.external_transaction_id || '---';
        const amountText = `${formatAmount(tx.amount)} جنية`;
        
        const rows = [
            ['الرقم المرجعي', referenceNumber],
            ['رقم عملية المزود', providerTxId],
            ['رقم طلب الأهرام', tx.customId || tx._id?.toString?.() || '---'],
            ['الخدمة', 'محافظ كاش'],
            ['وقت التنفيذ', dateStr]
        ].map(([label, value]) => `
            <div class="row">
                <span>${escapeHtml(label)}</span>
                <strong dir="ltr">${escapeHtml(value)}</strong>
            </div>
        `).join('');

        const htmlContent = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>
            * { box-sizing: border-box; }
            body { margin: 0; padding: 0; background: #eef7fb; color: #111827; font-family: Tahoma, Arial, sans-serif; }
            #receipt-container { width: 520px; min-height: 820px; padding: 20px; background: linear-gradient(145deg, #f8fcff, #eaf7f7); display: inline-block; border-radius: 26px; box-shadow: 0 18px 32px rgba(16,24,40,.18); overflow: hidden; }
            .header { height: 132px; border-radius: 24px; padding: 22px 24px; color: #fff; background: linear-gradient(135deg, #101828, #14546a 58%, #00a6a6); position: relative; box-shadow: 0 10px 18px rgba(16,24,40,.18); }
            .mark { position: absolute; left: 24px; bottom: 20px; width: 50px; height: 50px; border-radius: 50%; background: rgba(255,255,255,.15); display: grid; place-items: center; }
            .mark:after { content: ""; width: 34px; height: 34px; border-radius: 50%; background: #f5b83d; box-shadow: inset 0 2px 0 rgba(255,255,255,.45); }
            .title { font-size: 28px; font-weight: 900; margin: 0 0 8px; }
            .subtitle { color: #d8fffb; font-size: 15px; font-weight: 800; }
            .status-pill { margin: -21px auto 13px; width: 220px; height: 42px; border-radius: 21px; background: #fff; box-shadow: 0 10px 20px rgba(16,24,40,.16); display: flex; align-items: center; justify-content: center; gap: 10px; color: #12b76a; font-size: 18px; font-weight: 900; position: relative; }
            .status-dot { width: 24px; height: 24px; border-radius: 50%; background: #12b76a; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; }
            .focus-card { text-align: center; background: linear-gradient(135deg, #ffffff, #ecfffb); border: 1px solid #bdebe4; border-radius: 26px; padding: 13px 14px; margin: 12px 10px; box-shadow: 0 10px 18px rgba(16,24,40,.12); }
            .focus-card .label { font-size: 15px; font-weight: 900; color: #667085; margin-bottom: 7px; }
            .phone { direction: ltr; font-size: 36px; font-weight: 900; letter-spacing: 0; overflow-wrap: anywhere; color: #101828; }
            .amount { direction: ltr; font-size: 43px; font-weight: 900; letter-spacing: 0; overflow-wrap: anywhere; color: #00a6a6; }
            .details { margin: 14px 10px 0; border-radius: 22px; background: rgba(255,255,255,.84); border: 1px solid #d9e4ea; padding: 6px 18px; }
            .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 9px 0; border-bottom: 1px solid #d9e4ea; font-size: 15px; }
            .row:last-child { border-bottom: 0; }
            .row span { font-weight: 800; color: #667085; }
            .row strong { font-weight: 900; text-align: left; max-width: 250px; overflow-wrap: anywhere; color: #101828; }
            .support { margin: 12px 10px 0; padding: 10px 12px; border-radius: 20px; background: #fff7e6; border: 1px solid #f5d18b; text-align: center; line-height: 1.45; font-weight: 900; font-size: 15px; color: #101828; box-shadow: inset 0 1px 0 rgba(255,255,255,.85); }
            .support .number { direction: ltr; font-size: 23px; font-family: Arial, sans-serif; color: #00a6a6; }
            .footer { margin-top: 12px; text-align: center; padding-top: 12px; border-top: 1px solid #d9e4ea; font-size: 18px; font-weight: 900; font-family: Arial, sans-serif; color: #101828; }
        </style></head><body><div id="receipt-container">
            <div class="header">
                <div class="mark"></div>
                <div class="title">إيصال تحويل</div>
                <div class="subtitle">مستند تنفيذ إلكتروني معتمد</div>
            </div>
            <div class="status-pill"><span class="status-dot">✓</span><span>عملية ناجحة</span></div>
            <div class="focus-card">
                <div class="label">رقم الهاتف / الحساب</div>
                <div class="phone">${escapeHtml(targetNumber)}</div>
            </div>
            <div class="focus-card">
                <div class="label">القيمة</div>
                <div class="amount">${escapeHtml(amountText)}</div>
            </div>
            <div class="details">${rows}</div>
            <div class="support">
                <div>الدعم الفني واتساب فقط</div>
                <div class="number">${SUPPORT_PHONE}</div>
            </div>
            <div class="footer">Power Pay AL-Ahram</div>
        </div></body></html>`;
        
        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 15000, maxRedirects: 0 });
        await new Promise(resolve => setTimeout(resolve, 500)); 
        const element = await page.$('#receipt-container');
        return await element.screenshot({ type: 'jpeg', quality: 100 });
    });
};

const saveApiReceiptProof = async (tx, apiResult) => {
    let receiptBuffer = await generateCustomReceipt(tx, apiResult);
    if (!receiptBuffer) {
        const { generateReceiptBase64 } = require('../utils/receiptGenerator');
        const receiptBase64 = await generateReceiptBase64({
            amount: tx.amount,
            walletNumber: tx.vodafoneNumber || tx.accountNumber || '---',
            referenceNumber: apiResult.reference_number || apiResult.sender_number || apiResult.external_transaction_id || '---',
            customId: apiResult.external_transaction_id || tx.customId || tx._id?.toString?.() || '---',
            accountName: tx.companyName || tx.employeeName || tx.accountName || '---',
            serviceName: 'محافظ كاش',
            date: apiResult.transaction_time || new Date().toLocaleString('en-GB', { timeZone: SYSTEM_TIME_ZONE })
        });
        receiptBuffer = Buffer.from(receiptBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    }
    if (!receiptBuffer) return null;

    const uploadDir = path.join(process.cwd(), 'uploads', 'proofs');
    fs.mkdirSync(uploadDir, { recursive: true });
    const safeId = String(tx.customId || tx._id || 'api').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const fileName = `${safeId}_api_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(uploadDir, fileName), receiptBuffer);
    return `proofs/${fileName}`;
};

module.exports = {
    executeTransferViaApi,
    getApiProviderBalance,
    runApiTransferPreflight,
    getApiProviderTransaction,
    getApiProviderTransactions,
    isReturnedProviderStatus,
    isMaskedProviderReference,
    generateCustomReceipt,
    saveApiReceiptProof
};
