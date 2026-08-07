// services/authService.js
// ===============================================
// 🔐 خدمة المصادقة — تسجيل الدخول والخروج وتجديد التوكن
// ===============================================
'use strict';

const jwt = require('jsonwebtoken');
const { JWT_SECRET, JWT_REFRESH_SECRET } = require('../middlewares/jwtAuth');
const userRepo = require('../repositories/userRepository');
const settingsRepo = require('../repositories/settingsRepository');
const { logAction } = require('./auditService');
const { buildMobileRateContract, buildCompanyRateContract } = require('../utils/rateHelper');
const { applyCustomerRateMargins } = require('../utils/agencyPricing');
const {
    recordFailedLogin,
    resetFailedAttempts,
    isAccountLocked,
    extractDeviceInfo
} = require('./securityService');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const { buildContext } = require('../mappers/mobileAuthMapper');

const ACCESS_TOKEN_EXPIRY_SECONDS = 3600;      // 1 hour
const REFRESH_TOKEN_EXPIRY_SECONDS = 2592000;   // 30 days

const CLIENT_PERMISSIONS = Object.freeze([
    'client.home.read',
    'client.transfer.create',
    'client.transactions.read',
    'client.tickets.manage',
    'client.profile.read',
    'client.profile.update'
]);

const COMPANY_OWNER_PERMISSIONS = Object.freeze([
    ...CLIENT_PERMISSIONS,
    'company.dashboard.read',
    'company.employees.read',
    'company.employees.create',
    'company.employees.update_status',
    'company.employees.update_permissions',
    'company.reports.read',
    'company.reports.read_all'
]);

const COMPANY_MANAGER_PERMISSIONS = Object.freeze([
    ...CLIENT_PERMISSIONS,
    'company.dashboard.read',
    'company.employees.read',
    'company.employees.update_status',
    'company.employees.update_permissions',
    'company.reports.read',
    'company.reports.read_all'
]);

const COMPANY_EMPLOYEE_PERMISSIONS = Object.freeze([
    ...CLIENT_PERMISSIONS,
    'company.dashboard.read',
    'company.reports.read_day'
]);

const COMPANY_ACCOUNTANT_PERMISSIONS = Object.freeze([
    ...CLIENT_PERMISSIONS,
    'company.dashboard.read',
    'company.reports.read',
    'company.reports.read_all'
]);

const AGENT_OWNER_PERMISSIONS = Object.freeze([
    ...CLIENT_PERMISSIONS,
    'agent.dashboard.read',
    'agent.sub_accounts.read',
    'agent.sub_accounts.create',
    'agent.sub_accounts.update_status',
    'agent.sub_accounts.update_credit_limit',
    'agent.sub_accounts.settle',
    'agent.employees.read',
    'agent.employees.create',
    'agent.employees.update_status',
    'agent.registration_requests.read',
    'agent.registration_requests.review',
    'agent.reports.read',
    'agent.reports.read_all',
    'agent.reports.read_personal'
]);

const AGENT_MANAGER_PERMISSIONS = Object.freeze([
    ...CLIENT_PERMISSIONS,
    'agent.dashboard.read',
    'agent.registration_requests.read',
    'agent.registration_requests.review',
    'agent.reports.read',
    'agent.reports.read_all'
]);

const AGENT_EMPLOYEE_PERMISSIONS = Object.freeze([
    ...CLIENT_PERMISSIONS,
    'agent.dashboard.read',
    'agent.reports.read_day'
]);

const AGENT_ACCOUNTANT_PERMISSIONS = Object.freeze([
    ...CLIENT_PERMISSIONS,
    'agent.dashboard.read',
    'agent.reports.read',
    'agent.reports.read_all'
]);

const EXECUTOR_PERMISSIONS = Object.freeze([
    'executor.tasks.read',
    'executor.tasks.accept',
    'executor.tasks.cancel',
    'executor.tasks.complete',
    'executor.reports.read',
    'executor.profile.read'
]);

const resolveClientUserIdentity = (account) => {
    if (String(account.role || '').toLowerCase() === 'agent') {
        return {
            persona: 'agentOwner',
            role: 'agent',
            permissions: [...AGENT_OWNER_PERMISSIONS],
            agentId: String(account._id),
            agentName: account.name || null,
            agentCode: account.agentCode || account.accountCode || null
        };
    }

    return {
        persona: 'directClient',
        role: 'client',
        permissions: [...CLIENT_PERMISSIONS],
        agentId: null,
        agentName: null,
        agentCode: null
    };
};

const resolveCompanyIdentity = (account) => {
    const role = String(account.role || '').toLowerCase();
    if (role === 'accountant') {
        return {
            persona: 'companyAccountant',
            role: 'accountant',
            permissions: [...COMPANY_ACCOUNTANT_PERMISSIONS]
        };
    }

    const isLegacyOwner = role !== 'accountant'
        && account.canViewAllReports === true
        && account.canManageCompany !== true;
    const isOwner = role === 'owner' || account.canCreateCompanyStaff === true || isLegacyOwner;
    const isManager = isOwner || account.canManageCompany === true;
    return {
        persona: isOwner ? 'companyOwner' : (isManager ? 'companyManager' : 'companyEmployee'),
        role: isOwner ? 'owner' : (isManager ? 'manager' : 'employee'),
        permissions: isOwner
            ? [...COMPANY_OWNER_PERMISSIONS]
            : (isManager ? [...COMPANY_MANAGER_PERMISSIONS] : [...COMPANY_EMPLOYEE_PERMISSIONS])
    };
};

const resolveExecutorIdentity = () => ({
    persona: 'executor',
    role: 'executor',
    permissions: [...EXECUTOR_PERMISSIONS]
});

const resolveSubClientIdentity = () => ({
    persona: 'agentClient',
    role: 'client',
    permissions: [...CLIENT_PERMISSIONS]
});

const resolveAgentStaffIdentity = (account) => {
    const role = String(account.role || '').toLowerCase();
    if (role === 'accountant') {
        return {
            persona: 'agentAccountant',
            role: 'accountant',
            permissions: [...AGENT_ACCOUNTANT_PERMISSIONS]
        };
    }
    if (account.canManageAgent === true) {
        return {
            persona: 'agentManager',
            role: 'manager',
            permissions: [...AGENT_MANAGER_PERMISSIONS]
        };
    }
    return {
        persona: 'agentEmployee',
        role: 'employee',
        permissions: [...AGENT_EMPLOYEE_PERMISSIONS]
    };
};

const finiteNumberOr = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * تسجيل الدخول
 * @param {string} username
 * @param {string} password
 * @param {Object} req - Express request (لتتبع IP/UserAgent)
 * @returns {Promise<Object>} نتيجة تسجيل الدخول بصيغة العقد الرسمي
 */
const login = async (username, password, req) => {
    // 1. التحقق من قفل الحساب
    const lockStatus = isAccountLocked(username);
    if (lockStatus.locked) {
        await logAction({
            action: 'LOGIN_FAILED',
            req,
            performedByName: username,
            metadata: { reason: 'ACCOUNT_LOCKED', remainingMinutes: lockStatus.remainingLockTime },
            success: false,
            errorCode: 'ACCOUNT_LOCKED'
        });
        return {
            success: false,
            statusCode: 423,
            code: 'ACCOUNT_LOCKED',
            message: `الحساب مقفل مؤقتاً. يرجى المحاولة بعد ${lockStatus.remainingLockTime} دقيقة`
        };
    }

    // 2. البحث عن الحساب والمصادقة
    const result = await userRepo.findByCredentials(username, password, req.tenant ? req.tenant._id : null);

    if (!result) {
        const failResult = await recordFailedLogin(username, req);
        await logAction({
            action: 'LOGIN_FAILED',
            req,
            performedByName: username,
            metadata: { reason: 'INVALID_CREDENTIALS', remainingAttempts: failResult.remainingAttempts },
            success: false,
            errorCode: 'INVALID_CREDENTIALS'
        });
        return {
            success: false,
            statusCode: 401,
            code: 'INVALID_CREDENTIALS',
            message: 'بيانات الدخول غير صحيحة'
        };
    }

    if (result.error === 'ACCOUNT_BANNED') {
        await logAction({
            action: 'LOGIN_FAILED',
            req,
            performedByName: username,
            metadata: { reason: 'ACCOUNT_BANNED', accountType: result.accountType },
            success: false,
            errorCode: 'ACCOUNT_BANNED'
        });
        return {
            success: false,
            statusCode: 403,
            code: 'ACCOUNT_BANNED',
            message: 'الحساب معلق'
        };
    }

    // 3. نجاح المصادقة → توليد التوكنات
    const { account, accountType, telegramId, executorGroupId, balance } = result;
    resetFailedAttempts(username);

    const accessToken = jwt.sign(
        { userId: account._id, accountType, telegramId, executorGroupId },
        JWT_SECRET,
        { expiresIn: `${ACCESS_TOKEN_EXPIRY_SECONDS}s` }
    );
    const refreshToken = jwt.sign(
        { userId: account._id, accountType },
        JWT_REFRESH_SECRET,
        { expiresIn: `${REFRESH_TOKEN_EXPIRY_SECONDS}s` }
    );

    // حفظ refresh token
    await userRepo.updateRefreshToken(account._id, accountType, refreshToken);

    // 4. حساب سعر الصرف
    const settings = await settingsRepo.getSettings();
    let tier = 1;
    let companyName = null;
    let companyId = null;
    let executorBotName = null;
    let rateContract;
    let persona = undefined;
    let mobileRole = undefined;
    let mobilePermissions = undefined;
    let agentId = null;
    let agentName = null;
    let agentCode = null;
    let subAccountId = null;
    let subClientCreditLimit = undefined;
    let subClientDebt = undefined;
    let subClientAvailableToSpend = undefined;
    let subClientAccountCode = '';

    if (accountType === 'client_company') {
        const company = await ClientCompany.findById(account.companyId);
        tier = (company && company.tier) ? company.tier : 1;
        companyId = account.companyId;
        companyName = company ? company.name : null;
        rateContract = company
            ? buildCompanyRateContract(company, settings)
            : buildMobileRateContract(tier, settings);
        const identity = resolveCompanyIdentity(account);
        persona = identity.persona;
        mobileRole = identity.role;
        mobilePermissions = identity.permissions;
    } else if (accountType === 'client_user') {
        tier = account.tier || 1;
        rateContract = buildMobileRateContract(tier, settings);
        const identity = resolveClientUserIdentity(account);
        persona = identity.persona;
        mobileRole = identity.role;
        mobilePermissions = identity.permissions;
        agentId = identity.agentId;
        agentName = identity.agentName;
        agentCode = identity.agentCode;
    } else if (accountType === 'executor') {
        executorBotName = account.groupId ? account.groupId.name : (account.botId ? account.botId.name : null);
        rateContract = buildMobileRateContract(tier, settings);
        const identity = resolveExecutorIdentity();
        persona = identity.persona;
        mobileRole = identity.role;
        mobilePermissions = identity.permissions;
    } else if (accountType === 'agent_staff') {
        const agent = await User.findById(account.agentId);
        tier = agent ? (agent.tier || 1) : 1;
        rateContract = buildMobileRateContract(tier, settings);
        const identity = resolveAgentStaffIdentity(account);
        persona = identity.persona;
        mobileRole = identity.role;
        mobilePermissions = identity.permissions;
        agentId = agent ? String(agent._id) : null;
        agentName = agent ? agent.name : null;
        agentCode = agent ? (agent.agentCode || agent.accountCode || null) : null;
    } else if (accountType === 'sub_client') {
        let masterObj;
        if (account.masterType === 'user') {
            masterObj = await User.findById(account.masterId);
        } else {
            masterObj = await ClientCompany.findById(account.masterId);
        }
        tier = masterObj ? (masterObj.tier || 1) : 1;
        companyName = masterObj ? masterObj.name : null;
        companyId = account.masterType === 'company' ? account.masterId : null;

        const masterContract = account.masterType === 'company' && masterObj
            ? buildCompanyRateContract(masterObj, settings)
            : buildMobileRateContract(tier, settings);
        const subServiceRates = applyCustomerRateMargins(masterContract.serviceRates, account);
        const subBaseRate = subServiceRates.vodafone || masterContract.baseExchangeRate;

        rateContract = {
            tier: masterContract.tier,
            tierLabel: masterContract.tierLabel,
            baseExchangeRate: masterContract.baseExchangeRate,
            exchangeRate: subBaseRate,
            serviceRates: subServiceRates,
            serviceCatalog: masterContract.serviceCatalog
        };

        const identity = resolveSubClientIdentity();
        persona = identity.persona;
        mobileRole = identity.role;
        mobilePermissions = identity.permissions;
        agentId = account.masterType === 'user' && masterObj ? String(masterObj._id) : null;
        agentName = account.masterType === 'user' && masterObj ? masterObj.name : null;
        agentCode = account.masterType === 'user' && masterObj ? (masterObj.agentCode || masterObj.accountCode || null) : null;
        subAccountId = String(account._id);
        const subBalance = finiteNumberOr(account.balance, 0);
        const subCreditLimit = Math.max(0, finiteNumberOr(account.creditLimit, 0));
        subClientCreditLimit = subCreditLimit;
        subClientDebt = subBalance < 0 ? Math.abs(subBalance) : 0;
        subClientAvailableToSpend = subBalance + subCreditLimit;
        subClientAccountCode = account.accountCode || '';
    }
    const isOpen = !(settings && settings.isManualClosed);

    // 5. تسجيل في Audit Log
    await logAction({
        action: 'LOGIN_SUCCESS',
        req,
        performedById: account._id,
        performedByModel: userRepo.getModelName(accountType),
        performedByName: account.name,
        metadata: { accountType, ...extractDeviceInfo(req) }
    });

    // 6. إرجاع العقد الرسمي (بدون DTO mapping هنا — controller سيستخدم mapper)
    return {
        success: true,
        statusCode: 200,
        token: accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
        refreshExpiresIn: REFRESH_TOKEN_EXPIRY_SECONDS,
        id: String(account._id),
        accountType,
        name: account.name,
        balance: Number(balance) || 0,
        isOpen,
        ...rateContract,
        persona,
        role: mobileRole,
        permissions: mobilePermissions,
        creditLimit: subClientCreditLimit,
        debt: subClientDebt,
        availableToSpend: subClientAvailableToSpend,
        context: buildContext(accountType, {
            executorGroupId,
            executorGroupName: executorBotName,
            clientCompanyId: companyId,
            clientCompanyName: companyName,
            persona,
            agentId,
            agentName,
            agentCode,
            subAccountId,
            masterName: companyName,
            accountCode: subClientAccountCode
        })
    };
};

/**
 * تجديد توكن الوصول
 * @param {string} refreshToken
 * @param {Object} req
 */
const refreshAccessToken = async (refreshToken, req) => {
    return new Promise((resolve) => {
        jwt.verify(refreshToken, JWT_REFRESH_SECRET, async (err, decoded) => {
            if (err) {
                return resolve({
                    success: false,
                    statusCode: 403,
                    code: 'TOKEN_INVALID',
                    message: 'توكن غير صالح أو منتهي'
                });
            }

            try {
                const { userId, accountType } = decoded;
                const account = await userRepo.findById(userId, accountType, req.tenant ? req.tenant._id : null);

                if (!account || account.refreshToken !== refreshToken || account.status !== 'active') {
                    await logAction({
                        action: 'TOKEN_REFRESH',
                        req,
                        performedById: userId,
                        performedByModel: userRepo.getModelName(accountType),
                        success: false,
                        errorCode: 'SESSION_REVOKED'
                    });
                    return resolve({
                        success: false,
                        statusCode: 403,
                        code: 'SESSION_REVOKED',
                        message: 'تم إبطال الجلسة'
                    });
                }

                const telegramId = account.telegramId;
                const executorGroupId = accountType === 'executor' ? (account.groupId ? account.groupId._id : (account.botId ? account.botId._id : null)) : null;
                const newAccessToken = jwt.sign(
                    { userId: account._id, accountType, telegramId, executorGroupId },
                    JWT_SECRET,
                    { expiresIn: `${ACCESS_TOKEN_EXPIRY_SECONDS}s` }
                );

                resolve({
                    success: true,
                    statusCode: 200,
                    token: newAccessToken,
                    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
                    serverTime: new Date().toISOString()
                });
            } catch (e) {
                resolve({
                    success: false,
                    statusCode: 500,
                    code: 'SERVER_ERROR',
                    message: 'خطأ في السيرفر'
                });
            }
        });
    });
};

/**
 * تسجيل الخروج
 * @param {string} userId
 * @param {string} accountType
 */
const logout = async (userId, accountType) => {
    await userRepo.clearRefreshToken(userId, accountType);
    return {
        success: true,
        message: 'تم تسجيل الخروج وإبطال الجلسة',
        serverTime: new Date().toISOString()
    };
};

module.exports = { login, refreshAccessToken, logout };
