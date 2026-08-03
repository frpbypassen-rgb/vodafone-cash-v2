// mappers/mobileAuthMapper.js
// ===============================================
// 🔐 Mobile API — Auth Response DTO Mapper
// ===============================================
'use strict';

const {
    getEnabledMobileTransferServiceKeys
} = require('../utils/mobileTransferServiceCatalog');

const REQUIRED_ACCOUNT_TYPES = new Set(['client_user', 'client_company', 'executor', 'sub_client', 'agent_staff']);
const REQUIRED_PERSONAS = new Set([
    'directClient',
    'agentClient',
    'companyOwner',
    'companyEmployee',
    'companyManager',
    'companyAccountant',
    'agentOwner',
    'agentManager',
    'agentEmployee',
    'agentAccountant',
    'executor'
]);

const isBlank = (value) => value === undefined || value === null || value === '';

const malformedAuthDto = (fieldName) => {
    const error = new Error(`MALFORMED_AUTH_DTO:${fieldName}`);
    error.code = 'MALFORMED_RESPONSE';
    return error;
};

const requireString = (value, fieldName) => {
    if (isBlank(value)) throw malformedAuthDto(fieldName);
    return String(value);
};

const requireNumber = (value, fieldName) => {
    if (isBlank(value) || Number.isNaN(Number(value))) throw malformedAuthDto(fieldName);
    return Number(value);
};

const requirePositiveNumber = (value, fieldName) => {
    const num = Number(value);
    if (isBlank(value) || Number.isNaN(num) || num <= 0) throw malformedAuthDto(fieldName);
    return num;
};

const requireNonNegativeNumber = (value, fieldName) => {
    const num = Number(value);
    if (isBlank(value) || Number.isNaN(num) || num < 0) throw malformedAuthDto(fieldName);
    return num;
};

const requireTier = (value) => {
    const num = Number(value);
    if (isBlank(value) || Number.isNaN(num) || (num !== 1 && num !== 2 && num !== 3)) {
        throw malformedAuthDto('tier');
    }
    return num;
};

const requireServiceRates = (value) => {
    if (!value || typeof value !== 'object') throw malformedAuthDto('serviceRates');
    return getEnabledMobileTransferServiceKeys().reduce((rates, key) => {
        rates[key] = requirePositiveNumber(value[key], `serviceRates.${key}`);
        return rates;
    }, {});
};

const sanitizeServiceCatalog = (value) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw malformedAuthDto('serviceCatalog');
    return value.map(item => ({
        key: requireString(item && item.key, 'serviceCatalog.key'),
        label: requireString(item && item.label, 'serviceCatalog.label'),
        shortLabel: item && item.shortLabel ? String(item.shortLabel) : undefined,
        numberLabel: item && item.numberLabel ? String(item.numberLabel) : undefined,
        requiredFields: Array.isArray(item && item.requiredFields)
            ? item.requiredFields.map(String)
            : [],
        allowedSubtypes: Array.isArray(item && item.allowedSubtypes)
            ? item.allowedSubtypes.map(String)
            : undefined,
        enabled: item && item.enabled === true
    }));
};

const requireBoolean = (value, fieldName) => {
    if (typeof value !== 'boolean') throw malformedAuthDto(fieldName);
    return value;
};

const requirePersona = (value) => {
    const normalized = requireString(value, 'persona');
    if (!REQUIRED_PERSONAS.has(normalized)) {
        throw malformedAuthDto('persona');
    }
    return normalized;
};

/**
 * يحول نتيجة login الداخلية إلى DTO رسمي للموبايل.
 * لا يسرب أي حقول داخلية أو حساسة.
 *
 * @param {Object} params
 * @param {string} params.token - JWT access token
 * @param {string} params.refreshToken - JWT refresh token
 * @param {number} params.expiresIn - عمر access token بالثواني
 * @param {number} params.refreshExpiresIn - عمر refresh token بالثواني
 * @param {string} params.id - معرف الحساب
 * @param {string} params.accountType - نوع الحساب
 * @param {string} params.name - اسم المستخدم
 * @param {number} params.balance - الرصيد الحالي
 * @param {number} params.tier - مستوى العميل (1, 2, 3)
 * @param {string} params.tierLabel - اسم المستوى
 * @param {number} params.baseExchangeRate - سعر الصرف الأساسي
 * @param {number} params.exchangeRate - سعر الصرف الحالي
 * @param {Object} params.serviceRates - أسعار الخدمات
 * @param {boolean} params.isOpen - حالة المنظومة
 * @param {Object} params.context - سياق إضافي حسب نوع الحساب
 * @returns {Object} Login DTO
 */
const toLoginResponse = ({
    token,
    refreshToken,
    expiresIn,
    refreshExpiresIn,
    id,
    accountType,
    name,
    balance,
    tier,
    tierLabel,
    baseExchangeRate,
    exchangeRate,
    serviceRates,
    serviceCatalog,
    isOpen,
    context,
    persona,
    role,
    permissions,
    creditLimit,
    debt,
    availableToSpend
}) => {
    const normalizedAccountType = requireString(accountType, 'accountType');
    if (!REQUIRED_ACCOUNT_TYPES.has(normalizedAccountType)) {
        throw malformedAuthDto('accountType');
    }

    return {
        success: true,
        token: requireString(token, 'token'),
        refreshToken: requireString(refreshToken, 'refreshToken'),
        expiresIn: requireNumber(expiresIn, 'expiresIn'),
        refreshExpiresIn: requireNumber(refreshExpiresIn, 'refreshExpiresIn'),
        id: requireString(id, 'id'),
        accountType: normalizedAccountType,
        name: requireString(name, 'name'),
        balance: requireNumber(balance, 'balance'),
        tier: requireTier(tier),
        tierLabel: tierLabel ? String(tierLabel) : `مستوى ${Number(tier)}`,
        baseExchangeRate: requirePositiveNumber(baseExchangeRate, 'baseExchangeRate'),
        exchangeRate: requirePositiveNumber(exchangeRate, 'exchangeRate'),
        serviceRates: requireServiceRates(serviceRates),
        serviceCatalog: sanitizeServiceCatalog(serviceCatalog),
        isOpen: requireBoolean(isOpen, 'isOpen'),
        serverTime: new Date().toISOString(),
        persona: requirePersona(persona),
        role: role ? String(role) : undefined,
        permissions: Array.isArray(permissions) ? permissions.map(String) : undefined,
        creditLimit: creditLimit !== undefined ? requireNonNegativeNumber(creditLimit, 'creditLimit') : undefined,
        debt: debt !== undefined ? requireNonNegativeNumber(debt, 'debt') : undefined,
        availableToSpend: availableToSpend !== undefined ? requireNumber(availableToSpend, 'availableToSpend') : undefined,
        context: context || {
            clientCompanyId: null,
            clientCompanyName: null,
            executorGroupId: null,
            executorGroupName: null,
            executorBotId: null,
            executorBotName: null
        }
    };
};

/**
 * يحول نتيجة refresh الداخلية إلى DTO رسمي.
 */
const toRefreshResponse = ({ token, expiresIn, refreshToken, refreshExpiresIn }) => {
    const response = {
        success: true,
        token: requireString(token, 'token'),
        expiresIn: requireNumber(expiresIn, 'expiresIn'),
        serverTime: new Date().toISOString()
    };
    // فقط يرجع refreshToken لو تم تدويره فعلياً
    if (refreshToken) {
        response.refreshToken = requireString(refreshToken, 'refreshToken');
        response.refreshExpiresIn = requireNumber(refreshExpiresIn, 'refreshExpiresIn');
    }
    return response;
};

/**
 * يحول نتيجة logout الداخلية إلى DTO رسمي.
 */
const toLogoutResponse = () => {
    return {
        success: true,
        message: 'تم تسجيل الخروج وإبطال الجلسة',
        serverTime: new Date().toISOString()
    };
};

/**
 * يبني context حسب نوع الحساب.
 */
const buildContext = (accountType, {
    executorGroupId,
    executorGroupName,
    clientCompanyId,
    clientCompanyName,
    agentId,
    agentName,
    agentCode,
    subAccountId,
    displayType,
    masterName,
    accountCode
} = {}) => {
    if (accountType === 'sub_client') {
        return {
            displayType: displayType || 'حساب تابع',
            masterName: masterName || null,
            subAccountId: subAccountId ? String(subAccountId) : null,
            agentId: agentId ? String(agentId) : null,
            agentName: agentName || null,
            agentCode: agentCode || null,
            accountCode: accountCode || ''
        };
    }
    return {
        clientCompanyId: accountType === 'client_company' ? (clientCompanyId ? String(clientCompanyId) : null) : null,
        clientCompanyName: accountType === 'client_company' ? (clientCompanyName || null) : null,
        agentId: ['client_user', 'agent_staff'].includes(accountType) ? (agentId ? String(agentId) : null) : null,
        agentName: ['client_user', 'agent_staff'].includes(accountType) ? (agentName || null) : null,
        agentCode: ['client_user', 'agent_staff'].includes(accountType) ? (agentCode || null) : null,
        executorGroupId: accountType === 'executor' ? (executorGroupId ? String(executorGroupId) : null) : null,
        executorGroupName: accountType === 'executor' ? (executorGroupName || null) : null,
        // Legacy bot fields mapping the group info for compatibility
        executorBotId: accountType === 'executor' ? (executorGroupId ? String(executorGroupId) : null) : null,
        executorBotName: accountType === 'executor' ? (executorGroupName || null) : null
    };
};

module.exports = {
    toLoginResponse,
    toRefreshResponse,
    toLogoutResponse,
    buildContext
};
