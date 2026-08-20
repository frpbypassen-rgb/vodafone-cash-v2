// services/externalApiService.js
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const { SYSTEM_TIME_ZONE } = require('../config/systemTime');
const { getApiProviderPreset } = require('../utils/apiProviderPresets');

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

const normalizeProviderStatus = (value) => String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();

const isReturnedProviderStatus = (value) => {
    const status = normalizeProviderStatus(value);
    if (!status) return false;
    return [
        'مسترجع',
        'مسترد',
        'مرتجع',
        'مرتد',
        'مردود',
        'معكوس',
        'تم رد',
        'ملغ',
        'الغاء',
        'refund',
        'revers',
        'return',
        'cancel'
    ].some((marker) => status.includes(marker));
};

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
    providerTransactionId: String(data.TransactionId || fallbackTransactionNumber || '').trim(),
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

const resolveApiProviderConfig = (apiBot = {}) => {
    const preset = getApiProviderPreset(apiBot.apiProviderKey);
    const baseUrl = normalizeBaseUrl(apiBot.apiUrl || process.env.ZAYN_AGGREGATOR_URL || process.env.ZAYNPAY_URL || preset.apiUrl);

    return {
        preset,
        baseUrl,
        apiUsername: apiBot.apiUsername || process.env.ZAYN_USERNAME || process.env.ZAYNPAY_USERNAME,
        apiPassword: apiBot.apiPassword || process.env.ZAYN_PASSWORD || process.env.ZAYNPAY_PASSWORD,
        staticToken: (apiBot.apiToken || process.env.ZAYN_API_TOKEN || process.env.ZAYNPAY_API_TOKEN || '').replace(/^Bearer\s+/i, '').trim(),
        serviceId: parseNumberOrDefault(apiBot.apiServiceId || process.env.ZAYN_AGGREGATOR_SERVICE_ID || process.env.ZAYNPAY_SERVICE_ID, preset.serviceId),
        providerId: parseNumberOrDefault(apiBot.apiProviderId || process.env.ZAYN_AGGREGATOR_PROVIDER_ID || process.env.ZAYNPAY_PROVIDER_ID, preset.providerId),
        fieldId: parseNumberOrDefault(apiBot.apiFieldId || process.env.ZAYN_AGGREGATOR_FIELD_ID || process.env.ZAYNPAY_FIELD_ID, preset.fieldId),
        machineSerial: apiBot.apiMachineSerial || process.env.ZAYN_AGGREGATOR_MACHINE_SERIAL || process.env.ZAYNPAY_MACHINE_SERIAL || preset.machineSerial,
        defaultHeaders: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 Ahram-Server/1.0',
            'Accept': 'application/json',
            'app-version': 'xyz67'
        }
    };
};

const authorizeApiProvider = async (config, addLog) => {
    const authPayload = {
        UserName: config.apiUsername,
        Password: config.apiPassword,
        AppType: config.preset.appType,
        AppId: config.preset.appId,
        VersionID: config.preset.versionId
    };

    let freshToken = config.staticToken;
    if (!freshToken && (!authPayload.UserName || !authPayload.Password)) {
        addLog("AUTH_ERROR", "بيانات مزود الـ API مفقودة من بيانات المنفذ أو ملف .env");
        return { success: false, message: 'خطأ إعدادات: بيانات الاتصال مفقودة' };
    }

    if (!freshToken) {
        addLog("AUTH", "جاري إرسال طلب تسجيل الدخول...");
        const authRes = await axios.post(`${config.baseUrl}/api/Account/GetToken`, authPayload, { headers: config.defaultHeaders, timeout: 15000 });

        if (authRes.data.Code !== 200 || !authRes.data.Data || !authRes.data.Data.Access_Token) {
            addLog("AUTH_FAIL", authRes.data.Message || "تم رفض تسجيل الدخول من الشركة");
            return { success: false, message: 'فشل تسجيل الدخول لشركة زين' };
        }

        freshToken = authRes.data.Data.Access_Token;
        addLog("AUTH_SUCCESS", "تم استلام التوكن بنجاح");
    } else {
        addLog("AUTH_TOKEN", "تم استخدام Token محفوظ في بيانات المنفذ");
    }

    return {
        success: true,
        headers: { ...config.defaultHeaders, 'Authorization': `Bearer ${freshToken}`, 'Accept-Language': 'ar-EG' }
    };
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

const hasSuccessCode = (data) => Number(data?.Code) === 200;

const firstNonEmpty = (...values) => {
    for (const value of values) {
        const clean = String(value || '').trim();
        if (clean) return clean;
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
    if (!Number.isFinite(Number(config.fieldId)) || Number(config.fieldId) <= 0) issues.push('رقم حقل الخدمة غير صالح');
    if (!String(config.machineSerial || '').trim()) issues.push('الرقم التسلسلي للجهاز غير موجود');
    return issues;
};

const buildInquiryPayload = (config, targetNumber, amount) => ({
    Fields: [{ Id: config.fieldId, Value: targetNumber }],
    CurrentServiceProviderId: config.providerId,
    ServiceId: config.serviceId,
    MachineSerial: config.machineSerial,
    InqueryAmount: amount
});

const getApiProviderBalanceWithAuth = async (config, headers, addLog) => {
    addLog('BALANCE', 'Checking available provider balance');
    const balanceRes = await axios.post(`${config.baseUrl}/api/Account/GetBalance`, {}, { headers, timeout: 20000 });
    const responseData = balanceRes.data || {};
    const rawBalance = responseData.Data || {};

    if (!hasSuccessCode(responseData) || !responseData.Data) {
        const message = providerMessage(responseData, 'تم رفض استعلام رصيد المزود');
        addLog('BALANCE_FAIL', message || 'Unexpected provider response');
        return { success: false, message };
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
    const processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { timeZone: SYSTEM_TIME_ZONE, hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };
    const checks = [];
    let stage = 'configuration';

    try {
        const config = resolveApiProviderConfig(apiBot || {});
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

        addLog('CONFIG_SUCCESS', `${config.preset.name} | ServiceId=${config.serviceId} | CurrentServiceProviderId=${config.providerId} | FieldId=${config.fieldId}`);
        checks.push({ key: 'configuration', label: 'إعدادات الخدمة', status: 'success', message: 'البيانات الأساسية مكتملة' });

        stage = 'authentication';
        const auth = await authorizeApiProvider(config, addLog);
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
        const inquiryRes = await axios.post(
            `${config.baseUrl}/api/V1/Transactions/Inquiry`,
            buildInquiryPayload(config, targetNumber, amount),
            { headers: auth.headers, timeout: 20000 }
        );
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
        const message = errorMessage(error, 'تعذر الاتصال بالمزود أثناء اختبار التحويل');
        addLog(`${String(stage || 'system').toUpperCase()}_ERROR`, message);
        checks.push({ key: stage, label: 'اتصال مزود الخدمة', status: 'failed', message });
        return { success: false, stage, message, checks, processLog: processLog.join('\n') };
    }
};

const executeTransferViaApi = async (tx, apiBot) => {
    let processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { timeZone: SYSTEM_TIME_ZONE, hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };

    try {
        const targetNumber = normalizeApiTargetNumber(tx.vodafoneNumber || tx.accountNumber || tx.serviceDetails?.clientPhone);
        const amount = Number(tx.amount);
        const config = resolveApiProviderConfig(apiBot || {});
        const { preset, baseUrl, serviceId, providerId, fieldId, machineSerial } = config;
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
            return { success: false, message, processLog: processLog.join('\n') };
        }
        const auth = await authorizeApiProvider(config, addLog);
        if (!auth.success) {
            return { success: false, message: auth.message, processLog: processLog.join('\n') };
        }
        const headers = auth.headers;
        
        addLog("PROVIDER", `${preset.name} | ServiceId=${serviceId} | CurrentServiceProviderId=${providerId} | FieldId=${fieldId}`);
        addLog("INQUIRY", `جاري الاستعلام وفحص الرقم [${targetNumber}]...`);
        const inquiryPayload = buildInquiryPayload(config, targetNumber, amount);
        const inquiryRes = await axios.post(`${baseUrl}/api/V1/Transactions/Inquiry`, inquiryPayload, { headers, timeout: 20000 });
        const inquiryData = inquiryRes.data || {};

        if (!hasSuccessCode(inquiryData) || !inquiryData.Data || !inquiryData.Data.PaymentBillInfo) {
            const message = providerMessage(inquiryData, 'تم رفض الاستعلام عن التحويل من المزود');
            addLog("INQUIRY_FAIL", message || "Unexpected provider response");
            return { success: false, message, processLog: processLog.join('\n') };
        }
        
        addLog("INQUIRY_SUCCESS", "الرقم سليم ومتاح للتحويل.");
        addLog("PAYMENT", `جاري إرسال الدفعة النهائية بقيمة [${amount} EGP]...`);
        
        const paymentPayload = {
            Fields: [{ Id: fieldId, Value: targetNumber }],
            CurrentServiceProviderId: providerId,
            ServiceId: serviceId,
            PaymentBillInfo: inquiryData.Data.PaymentBillInfo,
            Amount: amount,
            MachineSerial: machineSerial
        };
        const paymentRes = await axios.post(`${baseUrl}/api/V1/Transactions/Payment`, paymentPayload, { headers, timeout: 180000 });

        const paymentData = paymentRes.data || {};
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

        const prettyLog = `
=========================================
[ التفاصيل المالية والتشغيلية للعملية ]
- رقم الموبايل   : ${targetNumber}
- القيمة         : ${pd.Amount || amount} EGP
- الرصيد قبل     : ${pd.BalanceBefore !== undefined ? pd.BalanceBefore + ' EGP' : '---'}
- الرصيد بعد     : ${pd.BalanceAfter !== undefined ? pd.BalanceAfter + ' EGP' : '---'}
- الحالة         : ${pd.Status || paymentData.Message || '---'}
- رقم العملية    : ${extRef || '---'}
- وقت العملية    : ${pd.TransactionTime || new Date().toLocaleString('ar-LY', { timeZone: SYSTEM_TIME_ZONE })}
- الرقم المرجعي  : ${refTxNum || 'غير متوفر'}
=========================================
[ الاستجابة البرمجية الخام - Raw JSON ]\n${JSON.stringify(paymentRes.data, null, 2)}`;

        const paymentAccepted = hasSuccessCode(paymentData)
            && paymentData.Data
            && Number(pd.IsFailure || 0) !== 1
            && (Boolean(pd.IsPaid) || Boolean(extRef) || Boolean(refTxNum));

        if (paymentAccepted) {
            if (!refTxNum || refTxNum.trim() === '') {
                addLog("PAYMENT_PENDING", `تم إرسال الدفعة ولكن لم يتم استلام المرجع من الشبكة.`);
                addLog("API_FULL_RESPONSE", prettyLog);
                return { success: 'pending', external_transaction_id: extRef, message: 'قيد الانتظار', processLog: processLog.join('\n') };
            }
            addLog("PAYMENT_SUCCESS", `اكتملت العملية بنجاح! رقم المرجع: ${extRef}`);
            addLog("API_FULL_RESPONSE", prettyLog);
            return {
                success: true,
                external_transaction_id: extRef || refTxNum,
                provider_transaction_id: extRef || refTxNum,
                reference_number: refTxNum,
                message: providerMessage(paymentData, 'تم التحويل الآلي'),
                sender_number: refTxNum,
                balance_before: pd.BalanceBefore,
                balance_after: pd.BalanceAfter,
                transaction_time: pd.TransactionTime || new Date().toLocaleString('ar-LY', { timeZone: SYSTEM_TIME_ZONE }),
                status: pd.Status || providerMessage(paymentData, 'عمليه ناجحه'),
                processLog: processLog.join('\n')
            };
        } else {
            const message = providerMessage(paymentData, 'تم رفض تنفيذ الدفعة من المزود');
            addLog("PAYMENT_FAIL", message);
            addLog("API_FULL_RESPONSE", prettyLog);
            return { success: false, message, processLog: processLog.join('\n') };
        }

    } catch (error) {
        const message = errorMessage(error, 'خطأ في الاتصال بسيرفر الشركة');
        addLog("SYSTEM_ERROR", message);
        return { success: false, message, processLog: processLog.join('\n') };
    }
};

const getApiProviderBalance = async (apiBot) => {
    const processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { timeZone: SYSTEM_TIME_ZONE, hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };

    try {
        const config = resolveApiProviderConfig(apiBot || {});
        const auth = await authorizeApiProvider(config, addLog);
        if (!auth.success) {
            return { success: false, message: auth.message, processLog: processLog.join('\n') };
        }

        const result = await getApiProviderBalanceWithAuth(config, auth.headers, addLog);
        return { ...result, processLog: processLog.join('\n') };
    } catch (error) {
        const message = errorMessage(error, 'خطأ في الاتصال بسيرفر مزود الخدمة');
        addLog("SYSTEM_ERROR", message);
        return { success: false, message, processLog: processLog.join('\n') };
    }
};

const getApiProviderTransactions = async (apiBot, transactionNumbers = []) => {
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
        const auth = await authorizeApiProvider(config, addLog);
        if (!auth.success) {
            return { success: false, message: auth.message, operations: [], processLog: processLog.join('\n') };
        }

        const operations = [];
        for (const transactionNumber of uniqueNumbers) {
            try {
                const printRes = await axios.post(
                    `${config.baseUrl}/api/V1/Transactions/Print`,
                    { TransactionNumber: transactionNumber },
                    { headers: auth.headers, timeout: 20000 }
                );
                const responseData = printRes.data || {};
                if (responseData.Code !== 200 || !responseData.Data) {
                    operations.push({
                        success: false,
                        providerTransactionId: transactionNumber,
                        requestedTransactionId: transactionNumber,
                        message: responseData.Message || 'تعذر استرجاع تفاصيل العملية من المزود'
                    });
                    continue;
                }

                operations.push({
                    success: true,
                    ...normalizeProviderTransaction(responseData.Data, transactionNumber),
                    requestedTransactionId: transactionNumber,
                    message: responseData.Message || 'تمت مراجعة العملية'
                });
            } catch (error) {
                const providerMessage = error.response && error.response.data
                    ? (error.response.data.Message || JSON.stringify(error.response.data))
                    : error.message;
                operations.push({
                    success: false,
                    providerTransactionId: transactionNumber,
                    requestedTransactionId: transactionNumber,
                    message: providerMessage || 'تعذر الاتصال بمسار مراجعة العمليات'
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
        const providerMessage = error.response && error.response.data
            ? (error.response.data.Message || JSON.stringify(error.response.data))
            : error.message;
        addLog('SYSTEM_ERROR', providerMessage);
        return {
            success: false,
            message: providerMessage || 'خطأ في الاتصال بمسار مراجعة عمليات المزود',
            operations: [],
            processLog: processLog.join('\n')
        };
    }
};

const getApiProviderTransaction = async (apiBot, transactionNumber) => {
    const result = await getApiProviderTransactions(apiBot, [transactionNumber]);
    if (!result.operations.length) {
        return { success: false, message: result.message || 'العملية غير موجودة لدى المزود' };
    }
    return result.operations[0];
};

// 🧾 صانع إيصالات الـ API الذكي
const generateCustomReceipt = async (tx, apiResult) => {
    let browser;
    try {
        const puppeteer = await loadPuppeteer();
        browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
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
        
        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(resolve => setTimeout(resolve, 500)); 
        const element = await page.$('#receipt-container');
        return await element.screenshot({ type: 'jpeg', quality: 100 });
    } catch (error) { return null; } finally { if (browser) await browser.close(); }
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
    generateCustomReceipt,
    saveApiReceiptProof
};
