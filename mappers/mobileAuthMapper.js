// mappers/mobileAuthMapper.js
// ===============================================
// 🔐 Mobile API — Auth Response DTO Mapper
// ===============================================
'use strict';

const REQUIRED_ACCOUNT_TYPES = new Set(['client_user', 'client_company', 'executor']);

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

const requireBoolean = (value, fieldName) => {
    if (typeof value !== 'boolean') throw malformedAuthDto(fieldName);
    return value;
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
 * @param {number} params.exchangeRate - سعر الصرف الحالي
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
    exchangeRate,
    isOpen,
    context
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
        exchangeRate: requireNumber(exchangeRate, 'exchangeRate'),
        isOpen: requireBoolean(isOpen, 'isOpen'),
        serverTime: new Date().toISOString(),
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
const buildContext = (accountType, { executorGroupId, executorGroupName, clientCompanyId, clientCompanyName } = {}) => {
    return {
        clientCompanyId: accountType === 'client_company' ? (clientCompanyId ? String(clientCompanyId) : null) : null,
        clientCompanyName: accountType === 'client_company' ? (clientCompanyName || null) : null,
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
