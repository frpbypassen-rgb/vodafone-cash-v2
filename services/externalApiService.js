// services/externalApiService.js
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const path = require('path');
const puppeteer = require('puppeteer');
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
const executeTransferViaApi = async (tx, apiBot) => {
    let processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };

    try {
        const targetNumber = tx.vodafoneNumber || tx.accountNumber;
        const amount = tx.amount;
        const config = resolveApiProviderConfig(apiBot || {});
        const { preset, baseUrl, serviceId, providerId, fieldId, machineSerial } = config;
        const auth = await authorizeApiProvider(config, addLog);
        if (!auth.success) {
            return { success: false, message: auth.message, processLog: processLog.join('\n') };
        }
        const headers = auth.headers;
        
        addLog("PROVIDER", `${preset.name} | ServiceId=${serviceId} | CurrentServiceProviderId=${providerId} | FieldId=${fieldId}`);
        addLog("INQUIRY", `جاري الاستعلام وفحص الرقم [${targetNumber}]...`);
        const inquiryPayload = {
            Fields: [{ Id: fieldId, Value: targetNumber }],
            CurrentServiceProviderId: providerId,
            ServiceId: serviceId,
            MachineSerial: machineSerial,
            InqueryAmount: amount
        };
        const inquiryRes = await axios.post(`${baseUrl}/api/V1/Transactions/Inquiry`, inquiryPayload, { headers, timeout: 20000 });

        if (inquiryRes.data.Code !== 200 || !inquiryRes.data.Data || !inquiryRes.data.Data.PaymentBillInfo) {
            addLog("INQUIRY_FAIL", inquiryRes.data.Message || "رد غير متوقع من سيرفر الشركة");
            return { success: false, message: 'تم رفض الاستعلام من الشركة', processLog: processLog.join('\n') };
        }
        
        addLog("INQUIRY_SUCCESS", "الرقم سليم ومتاح للتحويل.");
        addLog("PAYMENT", `جاري إرسال الدفعة النهائية بقيمة [${amount} EGP]...`);
        
        const paymentPayload = {
            Fields: [{ Id: fieldId, Value: targetNumber }],
            CurrentServiceProviderId: providerId,
            ServiceId: serviceId,
            PaymentBillInfo: inquiryRes.data.Data.PaymentBillInfo,
            Amount: amount,
            MachineSerial: machineSerial
        };
        const paymentRes = await axios.post(`${baseUrl}/api/V1/Transactions/Payment`, paymentPayload, { headers, timeout: 180000 });

        const pd = paymentRes.data.Data || {};
        const print = pd.PrintBill || {};
        const extRef = pd.TransactionNumber ? pd.TransactionNumber.toString() : '---';
        const refTxNum = String(pd.RefTransactionNumber || print.RefTransactionNumber || print.RefNumber || '').trim();

        const prettyLog = `
=========================================
[ التفاصيل المالية والتشغيلية للعملية ]
- رقم الموبايل   : ${targetNumber}
- القيمة         : ${pd.Amount || amount} EGP
- الرصيد قبل     : ${pd.BalanceBefore !== undefined ? pd.BalanceBefore + ' EGP' : '---'}
- الرصيد بعد     : ${pd.BalanceAfter !== undefined ? pd.BalanceAfter + ' EGP' : '---'}
- الحالة         : ${pd.Status || paymentRes.data.Message || '---'}
- رقم العملية    : ${extRef}
- وقت العملية    : ${pd.TransactionTime || new Date().toLocaleString('ar-EG')}
- الرقم المرجعي  : ${refTxNum || 'غير متوفر'}
=========================================
[ الاستجابة البرمجية الخام - Raw JSON ]\n${JSON.stringify(paymentRes.data, null, 2)}`;

        if (paymentRes.data.Code === 200 && paymentRes.data.Data && paymentRes.data.Data.TransactionNumber) {
            if (!refTxNum || refTxNum.trim() === '') {
                addLog("PAYMENT_PENDING", `تم إرسال الدفعة ولكن لم يتم استلام المرجع من الشبكة.`);
                addLog("API_FULL_RESPONSE", prettyLog);
                return { success: 'pending', external_transaction_id: extRef, message: 'قيد الانتظار', processLog: processLog.join('\n') };
            }
            addLog("PAYMENT_SUCCESS", `اكتملت العملية بنجاح! رقم المرجع: ${extRef}`);
            addLog("API_FULL_RESPONSE", prettyLog);
            return {
                success: true,
                external_transaction_id: extRef,
                provider_transaction_id: extRef,
                reference_number: refTxNum,
                message: paymentRes.data.Message || 'تم التحويل الآلي',
                sender_number: refTxNum,
                balance_before: pd.BalanceBefore,
                balance_after: pd.BalanceAfter,
                transaction_time: pd.TransactionTime || new Date().toLocaleString('ar-EG'),
                status: pd.Status || paymentRes.data.Message || 'عمليه ناجحه',
                processLog: processLog.join('\n')
            };
        } else {
            addLog("PAYMENT_FAIL", paymentRes.data.Message || "تم الرفض أثناء التنفيذ النهائي");
            addLog("API_FULL_RESPONSE", prettyLog);
            return { success: false, message: paymentRes.data.Message || 'تم الرفض', processLog: processLog.join('\n') };
        }

    } catch (error) {
        const providerMessage = error.response && error.response.data
            ? (error.response.data.Message || JSON.stringify(error.response.data))
            : error.message;
        addLog("SYSTEM_ERROR", providerMessage);
        return { success: false, message: providerMessage || 'خطأ في الاتصال بسيرفر الشركة', processLog: processLog.join('\n') };
    }
};

const getApiProviderBalance = async (apiBot) => {
    const processLog = [];
    const addLog = (step, detail) => {
        const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
        processLog.push(`[${timeStr}] ${step}: ${detail}`);
    };

    try {
        const config = resolveApiProviderConfig(apiBot || {});
        const auth = await authorizeApiProvider(config, addLog);
        if (!auth.success) {
            return { success: false, message: auth.message, processLog: processLog.join('\n') };
        }

        addLog("BALANCE", "جاري استعلام الرصيد المتاح من المزود...");
        const balanceRes = await axios.post(`${config.baseUrl}/api/Account/GetBalance`, {}, { headers: auth.headers, timeout: 20000 });
        const responseData = balanceRes.data || {};
        const rawBalance = responseData.Data || {};

        if (responseData.Code !== 200 || !responseData.Data) {
            addLog("BALANCE_FAIL", responseData.Message || "رد غير متوقع من مزود الخدمة");
            return {
                success: false,
                message: responseData.Message || 'فشل استعلام الرصيد من مزود الخدمة',
                processLog: processLog.join('\n')
            };
        }

        const serviceCredit = numberOrZero(rawBalance.ServiceCredit);
        const cashCredit = numberOrZero(rawBalance.CashCredit);
        const availableBalance = numberOrZero(rawBalance.AvailableBalance ?? rawBalance.Balance ?? (serviceCredit + cashCredit));

        addLog("BALANCE_SUCCESS", `ServiceCredit=${serviceCredit} | CashCredit=${cashCredit} | Available=${availableBalance}`);

        return {
            success: true,
            message: responseData.Message || 'تم استعلام الرصيد بنجاح',
            serviceCredit,
            cashCredit,
            availableBalance,
            balance: availableBalance,
            rawData: rawBalance,
            processLog: processLog.join('\n')
        };
    } catch (error) {
        const providerMessage = error.response && error.response.data
            ? (error.response.data.Message || JSON.stringify(error.response.data))
            : error.message;
        addLog("SYSTEM_ERROR", providerMessage);
        return { success: false, message: providerMessage || 'خطأ في الاتصال بسيرفر مزود الخدمة', processLog: processLog.join('\n') };
    }
};

// 🧾 صانع إيصالات الـ API الذكي
const generateCustomReceipt = async (tx, apiResult) => {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 520, height: 860 });
        
        const now = new Date();
        const dateStr = apiResult.transaction_time || now.toLocaleString('ar-EG-u-nu-latn', { hour12: true });
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
            date: apiResult.transaction_time || new Date().toLocaleString('en-GB')
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

module.exports = { executeTransferViaApi, getApiProviderBalance, generateCustomReceipt, saveApiReceiptProof };
