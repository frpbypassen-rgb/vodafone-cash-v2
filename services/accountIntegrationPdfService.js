'use strict';

const {
    findBrowserExecutable,
    getSharedBrowser,
    logoDataUri,
    renderView
} = require('./reportPdfService');

const SERVICE_LABELS = Object.freeze({
    vodafone: 'محافظ كاش',
    post_account: 'بريد حساب',
    post_card: 'بريد بطاقة',
    bank_account: 'حساب بنكي',
    sefa_niger: 'سيفا للنيجر',
    bankak_sudan: 'بنكك للسودان'
});

const API_PATH = '/api/v1/merchant';
const MERCHANT_TRANSFER_MIN_AMOUNT = 100;
const MERCHANT_TRANSFER_MAX_AMOUNT = 50000;

const normalizeOrigin = (value) => String(value || '').trim().replace(/\/+$/, '');

const resolvePublicApiOrigin = (req) => {
    const configured = normalizeOrigin(process.env.PUBLIC_APP_URL || process.env.APP_URL);
    if (/^https?:\/\//i.test(configured)) return configured;

    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'http';
    const host = String(req.get?.('host') || `127.0.0.1:${process.env.PORT || 3000}`).trim();
    return `${protocol}://${host}`;
};

const formatRate = (value) => {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? rate.toFixed(2) : 'غير متاح';
};

const accountLabel = (accountType) => accountType === 'agent' ? 'وكيل' : 'شركة';

const accountReference = (account = {}) => (
    account.accountCode || account.agentCode || String(account._id || '').slice(-8) || 'غير محدد'
);

const buildIntegrationDocumentData = ({
    account,
    accountType,
    apiKey,
    apiOrigin,
    serviceRates = {},
    environment = 'production',
    generatedAt = new Date()
}) => {
    const origin = normalizeOrigin(apiOrigin);
    const basePath = `${origin}${API_PATH}`;
    const profile = account.businessProfile || {};
    const reference = accountReference(account);
    const documentPrefix = accountType === 'agent' ? 'AG' : 'CO';
    const datePart = new Date(generatedAt).toISOString().slice(0, 10).replace(/-/g, '');
    const isSandbox = environment === 'sandbox';

    return {
        logoDataUri: logoDataUri(),
        generatedAt,
        documentNumber: `${isSandbox ? 'SBX-API' : 'API'}-${documentPrefix}-${reference}-${datePart}`,
        environment: {
            isSandbox,
            label: isSandbox ? 'بيئة الاختبار المعزولة' : 'بيئة الإنتاج',
            warning: isSandbox
                ? 'هذه بيانات اختبار فقط. لا تُرسل عمليات مالية حقيقية ولا تستخدم مفتاح الإنتاج في هذه البيئة.'
                : 'هذه بيانات إنتاج. احفظ مفتاح API في Secret Manager ولا تشاركه مع أي جهة غير مخولة.'
        },
        account: {
            name: account.name || 'جهة غير مسماة',
            typeLabel: accountLabel(accountType),
            accountCode: reference,
            phone: account.phone || 'غير مسجل',
            contactName: profile.contactName || account.name || 'غير مسجل',
            email: profile.email || 'غير مسجل',
            city: profile.city || 'غير مسجل',
            address: profile.address || 'غير مسجل',
            registrationNumber: profile.registrationNumber || 'غير مسجل',
            statusLabel: account.status === 'active' ? 'نشط وجاهز للربط' : 'موقوف حتى يتم تنشيط الحساب',
            apiKey: String(apiKey || '').trim()
        },
        api: {
            origin,
            basePath,
            balanceUrl: `${basePath}/balance`,
            transferUrl: `${basePath}/transfer`,
            statusUrl: `${basePath}/status/{invoice_number}`
        },
        transferPolicy: {
            minAmount: MERCHANT_TRANSFER_MIN_AMOUNT,
            maxAmount: MERCHANT_TRANSFER_MAX_AMOUNT,
            acceptedWhatsAppField: 'whatsapp_number',
            compatibilityWhatsAppField: 'client_phone'
        },
        services: Object.entries(SERVICE_LABELS).map(([key, label]) => ({
            key,
            label,
            rate: formatRate(serviceRates[key])
        })),
        examples: {
            balanceCurl: `curl --request GET "${basePath}/balance" \\\n+  --header "x-api-key: <API_KEY>" \\\n+  --header "Accept: application/json"`,
            transferCurl: `curl --request POST "${basePath}/transfer" \\\n+  --header "x-api-key: <API_KEY>" \\\n+  --header "Content-Type: application/json" \\\n+  --header "Accept: application/json" \\\n+  --data '{\n+    "target_number": "01012345678",\n+    "amount": 1000,\n+    "transfer_type": "vodafone",\n+    "whatsapp_number": "01108172258"\n+  }'`,
            statusCurl: `curl --request GET "${basePath}/status/ATT-2608-0001" \\\n+  --header "x-api-key: <API_KEY>" \\\n+  --header "Accept: application/json"`,
            transferJson: JSON.stringify({
                target_number: '01012345678',
                amount: 1000,
                transfer_type: 'vodafone',
                whatsapp_number: '01108172258'
            }, null, 2),
            transferResponse: JSON.stringify({
                status: 'success',
                data: {
                    invoice_number: 'ATT-2608-0001',
                    status: 'pending',
                    amount_egp: 1000,
                    exchange_rate: 5.95,
                    cost_lyd: 168.067,
                    balance: 9831.933,
                    receipt_whatsapp_number: '201108172258',
                    executor_name: 'مجموعة التنفيذ',
                    executor_number: null
                }
            }, null, 2)
        }
    };
};

const generateAccountIntegrationPdf = async (app, documentData) => {
    const executablePath = await findBrowserExecutable();
    if (!executablePath) {
        const error = new Error('PDF_BROWSER_NOT_FOUND');
        error.code = 'PDF_BROWSER_NOT_FOUND';
        throw error;
    }

    const html = await renderView(app, 'account_integration_pdf', documentData);
    let page;
    try {
        const browser = await getSharedBrowser(executablePath);
        page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        await page.emulateMediaType('print');
        const pdf = await page.pdf({
            format: 'A4',
            landscape: false,
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '8mm', right: '8mm', bottom: '14mm', left: '8mm' },
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `
                <div style="width:100%;padding:0 10mm;font-family:Arial,sans-serif;font-size:8px;color:#52616b;display:flex;justify-content:space-between;direction:rtl;">
                    <span>Power Pay AL-Ahram | وثيقة ربط API خاصة</span>
                    <span>صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></span>
                </div>
            `
        });
        return Buffer.from(pdf);
    } finally {
        if (page) await page.close().catch(() => {});
    }
};

module.exports = {
    API_PATH,
    MERCHANT_TRANSFER_MIN_AMOUNT,
    MERCHANT_TRANSFER_MAX_AMOUNT,
    SERVICE_LABELS,
    buildIntegrationDocumentData,
    generateAccountIntegrationPdf,
    resolvePublicApiOrigin
};
