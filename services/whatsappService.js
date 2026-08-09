'use strict';

const axios = require('axios');
const { SYSTEM_TIME_ZONE } = require('../config/systemTime');

const DEFAULT_WHATCHIMP_API_BASE_URL = 'https://app.whatchimp.com/api/v1/whatsapp';
const OTP_DEFAULT_VARIABLE_ORDER = ['otp', 'expiresMinutes', 'accountName', 'accountType'];
const RECEIPT_DEFAULT_VARIABLE_ORDER = ['accountName', 'reference', 'amount', 'currency', 'completedAt', 'receiptUrl'];

const isEnabled = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const cleanText = (value) => String(value ?? '').trim();

const getWhatChimpConfig = () => {
    const baseUrl = cleanText(process.env.WHATCHIMP_API_BASE_URL || DEFAULT_WHATCHIMP_API_BASE_URL).replace(/\/+$/, '');
    const enabled = isEnabled(process.env.WHATCHIMP_ENABLED);
    const apiToken = cleanText(process.env.WHATCHIMP_API_TOKEN);
    const phoneNumberId = cleanText(process.env.WHATCHIMP_PHONE_NUMBER_ID);
    const otpTemplate = cleanText(process.env.WHATCHIMP_OTP_TEMPLATE);
    const receiptTemplate = cleanText(process.env.WHATCHIMP_RECEIPT_TEMPLATE);
    const receiptMediaTemplateId = cleanText(process.env.WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID);

    return {
        enabled,
        baseUrl,
        apiToken,
        phoneNumberId,
        otpTemplate,
        otpLanguage: cleanText(process.env.WHATCHIMP_OTP_TEMPLATE_LANGUAGE || 'ar'),
        receiptTemplate,
        receiptLanguage: cleanText(process.env.WHATCHIMP_RECEIPT_TEMPLATE_LANGUAGE || 'ar'),
        receiptMediaTemplateId,
        otpVariableOrder: parseVariableOrder(process.env.WHATCHIMP_OTP_VARIABLE_ORDER, OTP_DEFAULT_VARIABLE_ORDER),
        receiptVariableOrder: parseVariableOrder(process.env.WHATCHIMP_RECEIPT_VARIABLE_ORDER, RECEIPT_DEFAULT_VARIABLE_ORDER),
        timeoutMs: Math.max(3000, Number(process.env.WHATCHIMP_REQUEST_TIMEOUT_MS) || 15000)
    };
};

const parseVariableOrder = (raw, fallback) => {
    const names = cleanText(raw)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    return names.length ? names : fallback;
};

const getWhatChimpConfigurationStatus = () => {
    const config = getWhatChimpConfig();
    const credentialIssues = [];
    if (!config.apiToken) credentialIssues.push('WHATCHIMP_API_TOKEN');
    if (!config.phoneNumberId) credentialIssues.push('WHATCHIMP_PHONE_NUMBER_ID');

    return {
        provider: config.enabled ? 'whatchimp' : 'disabled',
        enabled: config.enabled,
        credentialsReady: config.enabled && credentialIssues.length === 0,
        otpReady: config.enabled && credentialIssues.length === 0 && Boolean(config.otpTemplate),
        receiptReady: config.enabled
            && credentialIssues.length === 0
            && Boolean(config.receiptMediaTemplateId || config.receiptTemplate),
        supportReplyReady: config.enabled && credentialIssues.length === 0,
        receiptMode: config.receiptMediaTemplateId ? 'media-template' : (config.receiptTemplate ? 'template' : 'none'),
        missing: [
            ...(!config.enabled ? ['WHATCHIMP_ENABLED=true'] : []),
            ...credentialIssues,
            ...(config.enabled && !config.otpTemplate ? ['WHATCHIMP_OTP_TEMPLATE'] : []),
            ...(config.enabled && !config.receiptMediaTemplateId && !config.receiptTemplate
                ? ['WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID or WHATCHIMP_RECEIPT_TEMPLATE']
                : [])
        ],
        otpTemplate: config.otpTemplate || null,
        receiptTemplate: config.receiptTemplate || null,
        receiptMediaTemplateId: config.receiptMediaTemplateId || null
    };
};

const normalizeWhatsAppPhone = (phone) => {
    let normalized = cleanText(phone);
    if (!normalized) {
        const error = new Error('رقم واتساب مطلوب لإرسال الرسالة.');
        error.code = 'WHATSAPP_PHONE_REQUIRED';
        throw error;
    }

    normalized = normalized.replace(/\D/g, '');
    if (normalized.startsWith('00')) normalized = normalized.slice(2);

    // Egypt: 01108172258 -> 201108172258.
    if (normalized.startsWith('01') && normalized.length === 11) {
        normalized = `20${normalized.slice(1)}`;
    } else if (normalized.startsWith('1') && normalized.length === 10) {
        normalized = `20${normalized}`;
    // Libya: 0912345678 -> 218912345678.
    } else if (normalized.startsWith('09') && normalized.length === 10) {
        normalized = `218${normalized.slice(1)}`;
    } else if (normalized.startsWith('9') && normalized.length === 9) {
        normalized = `218${normalized}`;
    }

    if (!/^\d{8,15}$/.test(normalized)) {
        const error = new Error('رقم واتساب غير صالح. أدخل الرقم مع مفتاح الدولة أو رقماً مصرياً/ليبياً صحيحاً.');
        error.code = 'WHATSAPP_PHONE_INVALID';
        throw error;
    }

    return normalized;
};

const getResponseMessageId = (data = {}) => (
    data.wa_message_id
    || data.message_id
    || data.data?.wa_message_id
    || data.data?.message_id
    || null
);

const isSuccessfulResponse = (data = {}) => (
    data.success === true
    || data.status === 1
    || String(data.status || '').trim() === '1'
    || String(data.status || '').trim().toLowerCase() === 'true'
    || Boolean(getResponseMessageId(data))
);

const postWhatChimp = async (path, fields, config = getWhatChimpConfig()) => {
    const payload = new URLSearchParams();
    Object.entries(fields || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null) payload.append(key, String(value));
    });

    try {
        const response = await axios.post(`${config.baseUrl}${path}`, payload.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: config.timeoutMs
        });
        const data = response.data || {};
        const success = isSuccessfulResponse(data);
        return {
            success,
            provider: 'whatchimp',
            data,
            messageId: getResponseMessageId(data),
            code: success ? 'WHATCHIMP_SENT' : 'WHATCHIMP_REJECTED',
            message: cleanText(data.message || data.mesasge || '') || (success ? 'تم إرسال رسالة واتساب.' : 'رفض WhatChimp إرسال الرسالة.')
        };
    } catch (error) {
        const providerData = error.response?.data;
        return {
            success: false,
            provider: 'whatchimp',
            code: error.code === 'ECONNABORTED' ? 'WHATCHIMP_TIMEOUT' : 'WHATCHIMP_REQUEST_FAILED',
            message: cleanText(providerData?.message || providerData?.mesasge || error.message) || 'تعذر الاتصال بمنصة WhatChimp.',
            data: providerData || null
        };
    }
};

const buildTemplateVariables = (order, values) => order.map((key) => String(values[key] ?? ''));

const sendWhatChimpTemplate = async ({ phone, templateName, languageCode, variables = [] }) => {
    const config = getWhatChimpConfig();
    if (!config.enabled) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_DISABLED', message: 'تكامل WhatChimp غير مفعل.' };
    }
    if (!config.apiToken || !config.phoneNumberId || !templateName) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_CONFIG_MISSING', message: 'إعدادات WhatChimp أو قالب الرسالة غير مكتملة.' };
    }

    let phoneNumber;
    try {
        phoneNumber = normalizeWhatsAppPhone(phone);
    } catch (error) {
        return { success: false, provider: 'whatchimp', code: error.code || 'WHATSAPP_PHONE_INVALID', message: error.message };
    }

    const fields = {
        apiToken: config.apiToken,
        phone_number_id: config.phoneNumberId,
        phone_number: phoneNumber,
        template_name: templateName,
        language_code: languageCode
    };
    variables.forEach((value, index) => {
        fields[`variable${index + 1}`] = value;
    });

    const result = await postWhatChimp('/send', fields, config);
    return { ...result, phone: phoneNumber, templateName };
};

const sendWhatChimpMediaTemplate = async ({ phone, templateId, headerMediaUrl }) => {
    const config = getWhatChimpConfig();
    if (!config.enabled) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_DISABLED', message: 'تكامل WhatChimp غير مفعل.' };
    }
    if (!config.apiToken || !config.phoneNumberId || !templateId || !headerMediaUrl) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_CONFIG_MISSING', message: 'إعدادات قالب إيصال واتساب غير مكتملة.' };
    }

    let phoneNumber;
    try {
        phoneNumber = normalizeWhatsAppPhone(phone);
    } catch (error) {
        return { success: false, provider: 'whatchimp', code: error.code || 'WHATSAPP_PHONE_INVALID', message: error.message };
    }

    const result = await postWhatChimp('/send/template', {
        apiToken: config.apiToken,
        phone_number_id: config.phoneNumberId,
        phone_number: phoneNumber,
        template_id: templateId,
        template_header_media_url: headerMediaUrl
    }, config);
    return { ...result, phone: phoneNumber, templateId };
};

// WhatChimp only permits free-text support replies within the active WhatsApp conversation window.
const sendWhatChimpText = async ({ phone, message }) => {
    const config = getWhatChimpConfig();
    if (!config.enabled) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_DISABLED', message: 'WhatChimp integration is disabled.' };
    }
    if (!config.apiToken || !config.phoneNumberId) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_CONFIG_MISSING', message: 'WhatChimp credentials are incomplete.' };
    }

    const text = cleanText(message).slice(0, 4096);
    if (!text) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_TEXT_REQUIRED', message: 'A support reply is required.' };
    }

    let phoneNumber;
    try {
        phoneNumber = normalizeWhatsAppPhone(phone);
    } catch (error) {
        return { success: false, provider: 'whatchimp', code: error.code || 'WHATSAPP_PHONE_INVALID', message: error.message };
    }

    const result = await postWhatChimp('/send', {
        apiToken: config.apiToken,
        phone_number_id: config.phoneNumberId,
        phone_number: phoneNumber,
        message: text
    }, config);
    return { ...result, phone: phoneNumber };
};

const sendOtp = async ({ phone, otp, expiresMinutes = 5, accountName = '', accountType = '' }) => {
    const config = getWhatChimpConfig();
    if (config.enabled) {
        return sendWhatChimpTemplate({
            phone,
            templateName: config.otpTemplate,
            languageCode: config.otpLanguage,
            variables: buildTemplateVariables(config.otpVariableOrder, {
                otp,
                expiresMinutes,
                accountName,
                accountType
            })
        });
    }

    const legacyMessage = `رمز الدخول الخاص بك هو:\n\n*${otp}*\n\nالرمز صالح لمدة ${expiresMinutes} دقائق.`;
    const legacyResult = await sendLegacyWhatsAppMessage(phone, legacyMessage);
    return { ...legacyResult, code: legacyResult.success ? 'WPSENDER_SENT' : legacyResult.code };
};

const sendReceipt = async ({
    phone,
    accountName = '',
    reference = '',
    amount = '',
    currency = 'ج.م',
    completedAt = new Date(),
    receiptUrl = ''
}) => {
    const config = getWhatChimpConfig();
    if (!config.enabled) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_DISABLED', message: 'تكامل WhatChimp غير مفعل.' };
    }

    if (config.receiptMediaTemplateId) {
        return sendWhatChimpMediaTemplate({
            phone,
            templateId: config.receiptMediaTemplateId,
            headerMediaUrl: receiptUrl
        });
    }

    return sendWhatChimpTemplate({
        phone,
        templateName: config.receiptTemplate,
        languageCode: config.receiptLanguage,
        variables: buildTemplateVariables(config.receiptVariableOrder, {
            accountName,
            reference,
            amount,
            currency,
            completedAt: new Date(completedAt).toLocaleString('ar-LY', { timeZone: SYSTEM_TIME_ZONE }),
            receiptUrl
        })
    });
};

const testWhatChimpConnection = async () => {
    const config = getWhatChimpConfig();
    if (!config.enabled || !config.apiToken || !config.phoneNumberId) {
        return { success: false, provider: 'whatchimp', code: 'WHATCHIMP_CONFIG_MISSING', message: 'أكمل تفعيل WhatChimp وبيانات الربط أولاً.' };
    }

    try {
        const response = await axios.post(`${config.baseUrl}/template/list`, {
            apiToken: config.apiToken,
            phone_number_id: config.phoneNumberId
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: config.timeoutMs
        });
        const data = response.data || {};
        const success = isSuccessfulResponse(data);
        return {
            success,
            provider: 'whatchimp',
            code: success ? 'WHATCHIMP_CONNECTED' : 'WHATCHIMP_REJECTED',
            message: cleanText(data.message || data.mesasge || '') || (success ? 'تم الاتصال بـ WhatChimp.' : 'رفض WhatChimp اختبار الاتصال.'),
            data,
            templates: Array.isArray(data.message) ? data.message : (data.message ? [data.message] : [])
        };
    } catch (error) {
        return {
            success: false,
            provider: 'whatchimp',
            code: error.code === 'ECONNABORTED' ? 'WHATCHIMP_TIMEOUT' : 'WHATCHIMP_REQUEST_FAILED',
            message: cleanText(error.response?.data?.message || error.response?.data?.mesasge || error.message) || 'تعذر الاتصال بـ WhatChimp.'
        };
    }
};

const sendLegacyWhatsAppMessage = async (phone, message, bypassOtp = false) => {
    const apiUrl = cleanText(process.env.WPSENDER_API_URL);
    const apiKey = cleanText(process.env.WPSENDER_API_KEY);
    if (!apiUrl || !apiKey) {
        return { success: false, provider: 'wpsender', code: 'WPSENDER_CONFIG_MISSING', message: 'إعدادات WP Sender غير مكتملة.' };
    }

    if (!bypassOtp) {
        const isOtp = /رمز|كود|OTP|تحقق/i.test(String(message || ''));
        if (!isOtp) {
            return { success: false, provider: 'wpsender', code: 'WPSENDER_NON_OTP_BLOCKED', message: 'إرسال رسائل غير OTP عبر WP Sender محظور.' };
        }
    }

    let phoneNumber;
    try {
        phoneNumber = normalizeWhatsAppPhone(phone);
    } catch (error) {
        return { success: false, provider: 'wpsender', code: error.code || 'WHATSAPP_PHONE_INVALID', message: error.message };
    }

    try {
        await axios.post(apiUrl, { number: phoneNumber, message }, {
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            timeout: 15000
        });
        return { success: true, provider: 'wpsender', code: 'WPSENDER_SENT', phone: phoneNumber, message: 'تم إرسال رسالة واتساب.' };
    } catch (error) {
        return {
            success: false,
            provider: 'wpsender',
            code: error.code === 'ECONNABORTED' ? 'WPSENDER_TIMEOUT' : 'WPSENDER_REQUEST_FAILED',
            message: cleanText(error.response?.data?.message || error.message) || 'تعذر إرسال رسالة واتساب.'
        };
    }
};

const sendWhatsAppMessage = async (phone, message, bypassOtp = false) => (
    (await sendLegacyWhatsAppMessage(phone, message, bypassOtp)).success
);

const sendWhatsAppAlert = async (tx, apiResult = {}) => {
    const groupTarget = cleanText(process.env.WHATSAPP_GROUP_JID);
    if (!groupTarget) return false;

    const message = [
        '[تفاصيل مالية وتشغيلية للعملية]',
        `رقم الموبايل: ${tx.vodafoneNumber || tx.accountNumber || '---'}`,
        `القيمة: ${tx.amount || '---'} EGP`,
        `الرصيد قبل: ${apiResult.balance_before ?? '---'} EGP`,
        `الرصيد بعد: ${apiResult.balance_after ?? '---'} EGP`,
        `الحالة: ${apiResult.status || 'عملية ناجحة'}`,
        `رقم العملية: ${apiResult.external_transaction_id || '---'}`,
        `وقت العملية: ${apiResult.transaction_time || new Date().toLocaleString('ar-LY', { timeZone: SYSTEM_TIME_ZONE })}`,
        `الرقم المرجعي: ${apiResult.sender_number || '---'}`
    ].join('\n');

    return sendWhatsAppMessage(groupTarget, message, true);
};

module.exports = {
    getWhatChimpConfigurationStatus,
    normalizeWhatsAppPhone,
    sendOtp,
    sendReceipt,
    sendWhatChimpText,
    sendWhatChimpTemplate,
    sendWhatChimpMediaTemplate,
    sendWhatsAppAlert,
    sendWhatsAppMessage,
    testWhatChimpConnection
};
