'use strict';

const axios = require('axios');
const { SYSTEM_TIME_ZONE } = require('../config/systemTime');

const DEFAULT_WHATCHIMP_API_BASE_URL = 'https://app.whatchimp.com/api/v1/whatsapp';
const OTP_DEFAULT_VARIABLE_ORDER = ['otp', 'expiresMinutes', 'accountName', 'accountType'];
const RECEIPT_DEFAULT_VARIABLE_ORDER = ['accountName', 'reference', 'amount', 'currency', 'completedAt', 'receiptUrl'];
const RATE_CHANGE_DEFAULT_VARIABLE_ORDER = ['accountName', 'countdown', 'rateChanges', 'effectiveAt'];
const OTP_TEMPLATE_CACHE_TTL_MS = 60 * 1000;

let otpTemplateCache = {
    key: '',
    expiresAt: 0,
    value: null
};

const resetOtpTemplateCache = () => {
    otpTemplateCache = { key: '', expiresAt: 0, value: null };
};

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
    const rateChangeTemplate = cleanText(process.env.WHATCHIMP_RATE_CHANGE_TEMPLATE);
    const otpTemplateAutoDiscovery = process.env.WHATCHIMP_OTP_AUTO_DISCOVERY === undefined
        ? true
        : isEnabled(process.env.WHATCHIMP_OTP_AUTO_DISCOVERY);

    return {
        enabled,
        baseUrl,
        apiToken,
        phoneNumberId,
        otpTemplate,
        otpTemplateAutoDiscovery,
        otpTemplateCandidates: parseVariableOrder(
            process.env.WHATCHIMP_OTP_TEMPLATE_CANDIDATES,
            otpTemplate ? [otpTemplate] : []
        ),
        otpLanguage: cleanText(process.env.WHATCHIMP_OTP_TEMPLATE_LANGUAGE || 'ar'),
        receiptTemplate,
        receiptLanguage: cleanText(process.env.WHATCHIMP_RECEIPT_TEMPLATE_LANGUAGE || 'ar'),
        receiptMediaTemplateId,
        rateChangeTemplate,
        rateChangeLanguage: cleanText(process.env.WHATCHIMP_RATE_CHANGE_TEMPLATE_LANGUAGE || 'ar'),
        otpVariableOrder: parseVariableOrder(process.env.WHATCHIMP_OTP_VARIABLE_ORDER, OTP_DEFAULT_VARIABLE_ORDER),
        receiptVariableOrder: parseVariableOrder(process.env.WHATCHIMP_RECEIPT_VARIABLE_ORDER, RECEIPT_DEFAULT_VARIABLE_ORDER),
        rateChangeVariableOrder: parseVariableOrder(process.env.WHATCHIMP_RATE_CHANGE_VARIABLE_ORDER, RATE_CHANGE_DEFAULT_VARIABLE_ORDER),
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
        otpReady: config.enabled
            && credentialIssues.length === 0
            && Boolean(config.otpTemplate || config.otpTemplateAutoDiscovery),
        receiptReady: config.enabled
            && credentialIssues.length === 0
            && Boolean(config.receiptMediaTemplateId || config.receiptTemplate),
        rateChangeReady: config.enabled && credentialIssues.length === 0 && Boolean(config.rateChangeTemplate),
        supportReplyReady: config.enabled && credentialIssues.length === 0,
        receiptMode: config.receiptMediaTemplateId ? 'media-template' : (config.receiptTemplate ? 'template' : 'none'),
        missing: [
            ...(!config.enabled ? ['WHATCHIMP_ENABLED=true'] : []),
            ...credentialIssues,
            ...(config.enabled && !config.otpTemplate && !config.otpTemplateAutoDiscovery
                ? ['WHATCHIMP_OTP_TEMPLATE']
                : []),
            ...(config.enabled && !config.receiptMediaTemplateId && !config.receiptTemplate
                ? ['WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID or WHATCHIMP_RECEIPT_TEMPLATE']
                : []),
            // Rate-change alerts have their own optional approved template.
        ],
        otpTemplate: config.otpTemplate || null,
        receiptTemplate: config.receiptTemplate || null,
        receiptMediaTemplateId: config.receiptMediaTemplateId || null,
        rateChangeTemplate: config.rateChangeTemplate || null,
        rateChangeMissing: config.enabled && !config.rateChangeTemplate
            ? ['WHATCHIMP_RATE_CHANGE_TEMPLATE']
            : []
    };
};

const normalizeWhatsAppPhone = (phone) => {
    let normalized = cleanText(phone);
    if (!normalized) {
        const error = new Error('رقم واتساب مطلوب لإرسال الرسالة.');
        error.code = 'WHATSAPP_PHONE_REQUIRED';
        throw error;
    }

    normalized = normalized
        .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
        .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
        .replace(/\D/g, '');
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

const getTemplateList = (data = {}) => {
    const candidates = [data.message, data.data?.message, data.templates, data.data?.templates];
    return candidates.find(Array.isArray) || [];
};

const isApprovedTemplateStatus = (value) => /^(approved|active|enabled|live)$/i.test(String(value || '').trim());

const getTemplateName = (template = {}) => cleanText(template.template_name || template.name);

const getTemplateLocale = (template = {}) => cleanText(
    template.locale || template.language || template.language_code
);

const getTemplateCategory = (template = {}) => cleanText(
    template.template_category || template.category
).toLowerCase();

const isAuthenticationTemplate = (template = {}) => getTemplateCategory(template) === 'authentication';

const matchesLanguage = (template = {}, languageCode = '') => {
    const expected = cleanText(languageCode).toLowerCase();
    const actual = getTemplateLocale(template).toLowerCase();
    if (!expected || !actual) return true;
    return actual === expected || actual.split(/[_-]/)[0] === expected.split(/[_-]/)[0];
};

const getTemplateVariableCount = (template = {}) => {
    try {
        const variableMap = typeof template.variable_map === 'string'
            ? JSON.parse(template.variable_map)
            : template.variable_map;
        const bodyKeys = Object.keys(variableMap?.body || {});
        if (bodyKeys.length) return bodyKeys.length;
    } catch (_error) {
        // Fall through to the template body when the provider returns malformed metadata.
    }

    const source = [template.body_content, template.body, template.template_json]
        .map((value) => String(value || ''))
        .join(' ');
    const indexes = [...source.matchAll(/\{\{\s*(\d+)\s*\}\}/g)]
        .map((match) => Number(match[1]))
        .filter(Number.isFinite);
    return indexes.length ? Math.max(...indexes) : 1;
};

const selectApprovedOtpTemplate = (templates, config) => {
    const approvedAuthenticationTemplates = (Array.isArray(templates) ? templates : [])
        .filter((template) => isApprovedTemplateStatus(template.status || template.state))
        .filter(isAuthenticationTemplate)
        .filter((template) => matchesLanguage(template, config.otpLanguage));
    if (!approvedAuthenticationTemplates.length) return null;

    const preferredNames = [config.otpTemplate, ...config.otpTemplateCandidates]
        .map(cleanText)
        .filter(Boolean);
    for (const name of preferredNames) {
        const exact = approvedAuthenticationTemplates.find((template) => getTemplateName(template) === name);
        if (exact) return exact;
    }

    if (!config.otpTemplateAutoDiscovery) return null;
    return approvedAuthenticationTemplates
        .sort((left, right) => {
            const rightTime = Date.parse(right.updated_at || right.updatedAt || 0) || 0;
            const leftTime = Date.parse(left.updated_at || left.updatedAt || 0) || 0;
            return rightTime - leftTime;
        })[0];
};

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

const resolveOtpTemplate = async (config = getWhatChimpConfig()) => {
    const cacheKey = [
        config.phoneNumberId,
        config.otpTemplate,
        config.otpLanguage,
        config.otpTemplateCandidates.join(','),
        config.otpTemplateAutoDiscovery ? 'auto' : 'fixed'
    ].join('|');
    if (otpTemplateCache.key === cacheKey && otpTemplateCache.expiresAt > Date.now()) {
        return otpTemplateCache.value;
    }

    const connection = await testWhatChimpConnection();
    if (!connection.success) {
        return {
            success: false,
            code: connection.code || 'WHATCHIMP_REQUEST_FAILED',
            message: connection.message || 'تعذر التحقق من قوالب WhatChimp.'
        };
    }

    const selected = selectApprovedOtpTemplate(connection.templates, config);
    const value = selected
        ? {
            success: true,
            template: selected,
            name: getTemplateName(selected),
            language: getTemplateLocale(selected) || config.otpLanguage,
            variableCount: getTemplateVariableCount(selected)
        }
        : {
            success: false,
            code: 'WHATCHIMP_OTP_TEMPLATE_NOT_APPROVED',
            message: 'لا يوجد قالب مصادقة OTP معتمد ومطابق للغة الحساب في WhatChimp.'
        };

    otpTemplateCache = {
        key: cacheKey,
        expiresAt: Date.now() + OTP_TEMPLATE_CACHE_TTL_MS,
        value
    };
    return value;
};

const sendOtp = async ({ phone, otp, expiresMinutes = 5, accountName = '', accountType = '' }) => {
    const config = getWhatChimpConfig();
    if (config.enabled) {
        if (!config.apiToken || !config.phoneNumberId) {
            return {
                success: false,
                provider: 'whatchimp',
                // Keep the public error code stable for existing clients while
                // retaining the OTP-specific detail in the message.
                code: 'WHATCHIMP_CONFIG_MISSING',
                message: 'بيانات WhatsApp أو قالب رمز التحقق غير مكتملة.'
            };
        }
        const resolvedTemplate = await resolveOtpTemplate(config);
        if (!resolvedTemplate.success) {
            return { ...resolvedTemplate, provider: 'whatchimp' };
        }
        const variables = buildTemplateVariables(config.otpVariableOrder, {
            otp,
            expiresMinutes,
            accountName,
            accountType
        }).slice(0, resolvedTemplate.variableCount);
        return sendWhatChimpTemplate({
            phone,
            templateName: resolvedTemplate.name,
            languageCode: resolvedTemplate.language,
            variables
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
        const templates = getTemplateList(data);
        const providerMessage = typeof data.message === 'string'
            ? cleanText(data.message)
            : (typeof data.mesasge === 'string' ? cleanText(data.mesasge) : '');
        return {
            success,
            provider: 'whatchimp',
            code: success ? 'WHATCHIMP_CONNECTED' : 'WHATCHIMP_REJECTED',
            message: providerMessage || (success ? 'تم الاتصال بـ WhatChimp.' : 'رفض WhatChimp اختبار الاتصال.'),
            data,
            templates
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

const sendRateChange = async ({
    phone,
    accountName = '',
    countdown = '01:00',
    rateChanges = '',
    effectiveAt = new Date()
}) => {
    const config = getWhatChimpConfig();
    return sendWhatChimpTemplate({
        phone,
        templateName: config.rateChangeTemplate,
        languageCode: config.rateChangeLanguage,
        variables: buildTemplateVariables(config.rateChangeVariableOrder, {
            accountName,
            countdown,
            rateChanges,
            effectiveAt: new Date(effectiveAt).toLocaleString('ar-LY', { timeZone: SYSTEM_TIME_ZONE })
        })
    });
};

const getWhatChimpTemplateReadiness = async () => {
    const configuration = getWhatChimpConfigurationStatus();
    const connection = await testWhatChimpConnection();
    const templates = Array.isArray(connection.templates) ? connection.templates : [];
    const findTemplate = ({ id, name }) => templates.find((template) => (
        (id && String(template.id || '') === String(id))
        || (name && String(template.template_name || template.name || '').trim() === String(name).trim())
    ));
    const config = getWhatChimpConfig();
    const receiptTemplate = config.receiptMediaTemplateId
        ? findTemplate({ id: config.receiptMediaTemplateId })
        : findTemplate({ name: config.receiptTemplate });
    const configuredOtpTemplate = findTemplate({ name: config.otpTemplate });
    const otpTemplate = selectApprovedOtpTemplate(templates, config) || configuredOtpTemplate;
    const rateChangeTemplate = findTemplate({ name: config.rateChangeTemplate });
    const toState = (template, required) => {
        if (!required) return { required: false, found: false, status: '', approved: false };
        const status = String(template?.status || template?.state || '').trim();
        return {
            required: true,
            found: Boolean(template),
            id: template?.id ? String(template.id) : '',
            name: String(template?.template_name || template?.name || ''),
            status,
            approved: isApprovedTemplateStatus(status),
            category: cleanText(template?.template_category || template?.category),
            locale: getTemplateLocale(template)
        };
    };
    const receipt = toState(receiptTemplate, Boolean(config.receiptMediaTemplateId || config.receiptTemplate));
    const otp = toState(otpTemplate, Boolean(config.otpTemplate));
    const rateChange = toState(rateChangeTemplate, Boolean(config.rateChangeTemplate));

    return {
        ...configuration,
        providerConnected: connection.success,
        providerMessage: connection.message,
        receiptTemplate: receipt,
        otpTemplate: otp,
        rateChangeTemplate: rateChange,
        receiptOperational: Boolean(configuration.receiptReady && connection.success && receipt.approved),
        otpOperational: Boolean(
            configuration.otpReady
            && connection.success
            && otp.approved
            && isAuthenticationTemplate(otpTemplate)
        ),
        rateChangeOperational: Boolean(configuration.rateChangeReady && connection.success && rateChange.approved)
    };
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
    sendRateChange,
    sendWhatChimpText,
    sendWhatChimpTemplate,
    sendWhatChimpMediaTemplate,
    sendWhatsAppAlert,
    sendWhatsAppMessage,
    testWhatChimpConnection,
    getWhatChimpTemplateReadiness,
    resetOtpTemplateCache
};
