// services/authService.js
// ===============================================
// 🔐 خدمة المصادقة — تسجيل الدخول والخروج وتجديد التوكن
// ===============================================
'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
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
const MobileDeviceSession = require('../models/MobileDeviceSession');
const { buildContext } = require('../mappers/mobileAuthMapper');

const requestedAccessTokenTtl = Number(process.env.ACCESS_TOKEN_TTL_SECONDS);
const ACCESS_TOKEN_EXPIRY_SECONDS = Number.isFinite(requestedAccessTokenTtl)
    ? Math.min(3600, Math.max(300, requestedAccessTokenTtl))
    : (process.env.NODE_ENV === 'production' ? 900 : 3600);
const REFRESH_TOKEN_EXPIRY_SECONDS = 2592000;   // 30 days
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const cleanId = (value) => value === undefined || value === null ? '' : String(value).trim();
const requestTenantId = (req) => cleanId(req && req.tenant && req.tenant._id);
const allowsLegacyTenantTokens = () => (
    process.env.NODE_ENV !== 'production'
    && String(process.env.ALLOW_LEGACY_TENANT_TOKENS || 'true').toLowerCase() === 'true'
);
const tokenMatchesTenant = (decoded, req) => {
    const currentTenantId = requestTenantId(req);
    const tokenTenantId = cleanId(decoded && decoded.tenantId);
    if (!currentTenantId) return process.env.NODE_ENV !== 'production';
    if (!tokenTenantId) return allowsLegacyTenantTokens();
    return currentTenantId === tokenTenantId;
};
const findTenantScopedById = (Model, id, req) => {
    const tenantId = requestTenantId(req);
    if (!tenantId) return Model.findById(id);
    return Model.findOne(userRepo.applyTenantScope({ _id: id }, tenantId));
};

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

const EXECUTOR_TASK_PERMISSIONS = Object.freeze([
    'executor.tasks.read',
    'executor.tasks.accept',
    'executor.tasks.cancel',
    'executor.tasks.complete'
]);

const EXECUTOR_MANAGER_PERMISSIONS = Object.freeze([
    ...EXECUTOR_TASK_PERMISSIONS,
    'executor.reports.read',
    'executor.reports.read_all',
    'executor.profile.read',
    'executor.balance.read',
    'executor.employees.read',
    'executor.employees.manage'
]);

const EXECUTOR_OPERATOR_PERMISSIONS = Object.freeze([
    ...EXECUTOR_TASK_PERMISSIONS,
    'executor.reports.read_day',
    'executor.profile.read',
    'executor.performance.read'
]);

const EXECUTOR_ACCOUNTANT_PERMISSIONS = Object.freeze([
    'executor.reports.read',
    'executor.reports.read_all',
    'executor.profile.read',
    'executor.balance.read'
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

const resolveExecutorIdentity = (account) => {
    const requestedRole = String(account && account.role || '').toLowerCase();
    const role = ['manager', 'operator', 'accountant'].includes(requestedRole)
        ? requestedRole
        : 'operator';

    const permissions = role === 'manager'
        ? EXECUTOR_MANAGER_PERMISSIONS
        : (role === 'accountant' ? EXECUTOR_ACCOUNTANT_PERMISSIONS : EXECUTOR_OPERATOR_PERMISSIONS);

    return {
        persona: 'executor',
        role,
        permissions: [...permissions]
    };
};

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

    const isCustomerMobileSession = ['client_user', 'sub_client'].includes(accountType);
    const mobileSessionId = isCustomerMobileSession ? crypto.randomUUID() : null;
    const tenantId = requestTenantId(req) || cleanId(account.tenantId) || null;
    const accessToken = jwt.sign(
        {
            userId: account._id,
            accountType,
            telegramId,
            executorGroupId,
            sessionVersion: Number(account.sessionVersion || 0),
            sessionId: mobileSessionId,
            tenantId
        },
        JWT_SECRET,
        { expiresIn: `${ACCESS_TOKEN_EXPIRY_SECONDS}s` }
    );
    const refreshToken = jwt.sign(
        {
            userId: account._id,
            accountType,
            sessionVersion: Number(account.sessionVersion || 0),
            sessionId: mobileSessionId,
            tenantId,
            jti: crypto.randomUUID()
        },
        JWT_REFRESH_SECRET,
        { expiresIn: `${REFRESH_TOKEN_EXPIRY_SECONDS}s` }
    );

    // Sessions for customer mobile devices are independent. One device must not
    // invalidate another customer's refresh token.
    if (isCustomerMobileSession) {
        const device = extractDeviceInfo(req);
        await MobileDeviceSession.create({
            accountId: account._id,
            accountType,
            tenantId: tenantId || undefined,
            sessionId: mobileSessionId,
            refreshTokenHash: hashToken(refreshToken),
            deviceFingerprint: device.deviceFingerprint,
            userAgent: device.userAgent,
            deviceType: 'هاتف'
        });
    } else {
        await userRepo.updateRefreshToken(account._id, accountType, refreshToken);
    }

    // 4. حساب سعر الصرف
    const settings = await settingsRepo.getSettings();
    let tier = 1;
    let companyName = null;
    let companyId = null;
    let executorBotName = null;
    let executorServiceKey = null;
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
        const company = await findTenantScopedById(ClientCompany, account.companyId, req);
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
        executorServiceKey = account.groupId
            ? (account.groupId.serviceKey || null)
            : (account.botId ? (account.botId.serviceKey || null) : null);
        rateContract = buildMobileRateContract(tier, settings);
        const identity = resolveExecutorIdentity(account);
        persona = identity.persona;
        mobileRole = identity.role;
        mobilePermissions = identity.permissions;
    } else if (accountType === 'agent_staff') {
        const agent = await findTenantScopedById(User, account.agentId, req);
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
            masterObj = await findTenantScopedById(User, account.masterId, req);
        } else {
            masterObj = await findTenantScopedById(ClientCompany, account.masterId, req);
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
    const accountAddress = account.address
        || (account.businessProfile && (account.businessProfile.address || account.businessProfile.city))
        || '';
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
            executorRole: mobileRole,
            executorServiceKey,
            clientCompanyId: companyId,
            clientCompanyName: companyName,
            persona,
            agentId,
            agentName,
            agentCode,
            subAccountId,
            masterName: companyName,
            accountCode: subClientAccountCode || account.accountCode || '',
            username: account.webUsername || '',
            phone: account.phone || '',
            address: accountAddress,
            joinedAt: account.createdAt || null,
            profilePhotoUpdatedAt: account.profilePhotoUpdatedAt || null,
            status: account.status || 'active'
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
                if (!tokenMatchesTenant(decoded, req)) {
                    await logAction({
                        action: 'TOKEN_REFRESH',
                        req,
                        performedById: userId,
                        performedByModel: userRepo.getModelName(accountType),
                        success: false,
                        errorCode: 'TENANT_TOKEN_MISMATCH'
                    });
                    return resolve({
                        success: false,
                        statusCode: 403,
                        code: 'TENANT_ACCESS_DENIED',
                        message: 'رمز الدخول لا يخص هذه المنظمة'
                    });
                }
                const account = await userRepo.findById(userId, accountType, req.tenant ? req.tenant._id : null);

                const isCustomerMobileSession = ['client_user', 'sub_client'].includes(accountType);
                const presentedTokenHash = hashToken(refreshToken);
                const deviceSession = isCustomerMobileSession && decoded.sessionId
                    ? await MobileDeviceSession.findOne({
                        accountId: userId,
                        accountType,
                        ...(decoded.tenantId ? { tenantId: decoded.tenantId } : {}),
                        sessionId: decoded.sessionId,
                        active: true
                    })
                    : null;
                const refreshTokenMatches = isCustomerMobileSession && decoded.sessionId
                    ? Boolean(deviceSession && deviceSession.refreshTokenHash === presentedTokenHash)
                    : account && account.refreshToken === refreshToken;

                if (!account || !refreshTokenMatches || account.status !== 'active'
                    || Number(account.sessionVersion || 0) !== Number(decoded.sessionVersion || 0)) {
                    if (deviceSession && deviceSession.refreshTokenHash !== presentedTokenHash) {
                        await MobileDeviceSession.updateOne(
                            { _id: deviceSession._id, active: true },
                            {
                                $set: {
                                    active: false,
                                    revokedAt: new Date(),
                                    revokeReason: 'REFRESH_TOKEN_REUSE'
                                }
                            }
                        );
                    }
                    await logAction({
                        action: 'TOKEN_REFRESH',
                        req,
                        performedById: userId,
                        performedByModel: userRepo.getModelName(accountType),
                        success: false,
                        errorCode: deviceSession ? 'REFRESH_TOKEN_REUSE' : 'SESSION_REVOKED'
                    });
                    return resolve({
                        success: false,
                        statusCode: 403,
                        code: deviceSession ? 'TOKEN_REUSE_DETECTED' : 'SESSION_REVOKED',
                        message: 'تم إبطال الجلسة'
                    });
                }

                const telegramId = account.telegramId;
                const executorGroupId = accountType === 'executor' ? (account.groupId ? account.groupId._id : (account.botId ? account.botId._id : null)) : null;
                const nextSessionId = decoded.sessionId || (isCustomerMobileSession ? crypto.randomUUID() : null);
                const tenantId = requestTenantId(req) || cleanId(decoded.tenantId) || cleanId(account.tenantId) || null;
                const nextRefreshToken = jwt.sign(
                    {
                        userId: account._id,
                        accountType,
                        sessionVersion: Number(account.sessionVersion || 0),
                        sessionId: nextSessionId,
                        tenantId,
                        jti: crypto.randomUUID()
                    },
                    JWT_REFRESH_SECRET,
                    { expiresIn: `${REFRESH_TOKEN_EXPIRY_SECONDS}s` }
                );
                const newAccessToken = jwt.sign(
                    {
                        userId: account._id,
                        accountType,
                        telegramId,
                        executorGroupId,
                        sessionVersion: Number(account.sessionVersion || 0),
                        sessionId: nextSessionId,
                        tenantId
                    },
                    JWT_SECRET,
                    { expiresIn: `${ACCESS_TOKEN_EXPIRY_SECONDS}s` }
                );

                if (deviceSession) {
                    const rotation = await MobileDeviceSession.updateOne(
                        { _id: deviceSession._id, active: true, refreshTokenHash: presentedTokenHash },
                        {
                            $set: {
                                refreshTokenHash: hashToken(nextRefreshToken),
                                lastSeenAt: new Date(),
                                lastRotatedAt: new Date()
                            },
                            $inc: { rotationCounter: 1 }
                        }
                    );
                    if (rotation.modifiedCount !== 1) {
                        return resolve({
                            success: false,
                            statusCode: 403,
                            code: 'SESSION_REVOKED',
                            message: 'تم إبطال الجلسة'
                        });
                    }
                } else if (isCustomerMobileSession) {
                    // One-time migration for refresh tokens issued before per-device sessions.
                    const device = extractDeviceInfo(req);
                    await MobileDeviceSession.create({
                        accountId: account._id,
                        accountType,
                        tenantId: tenantId || undefined,
                        sessionId: nextSessionId,
                        refreshTokenHash: hashToken(nextRefreshToken),
                        deviceFingerprint: device.deviceFingerprint,
                        userAgent: device.userAgent,
                        deviceType: 'هاتف',
                        rotationCounter: 1,
                        lastRotatedAt: new Date()
                    });
                    await userRepo.clearRefreshToken(account._id, accountType);
                } else {
                    const rotation = await userRepo.rotateRefreshToken(
                        account._id,
                        accountType,
                        refreshToken,
                        nextRefreshToken
                    );
                    if (rotation.modifiedCount !== 1) {
                        return resolve({
                            success: false,
                            statusCode: 403,
                            code: 'SESSION_REVOKED',
                            message: 'تم إبطال الجلسة'
                        });
                    }
                }

                await logAction({
                    action: 'TOKEN_REFRESH',
                    req,
                    performedById: userId,
                    performedByModel: userRepo.getModelName(accountType),
                    success: true,
                    metadata: { sessionId: nextSessionId }
                });

                resolve({
                    success: true,
                    statusCode: 200,
                    token: newAccessToken,
                    refreshToken: nextRefreshToken,
                    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
                    refreshExpiresIn: REFRESH_TOKEN_EXPIRY_SECONDS,
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
const logout = async (userId, accountType, sessionId = null) => {
    if (['client_user', 'sub_client'].includes(accountType) && sessionId) {
        await MobileDeviceSession.updateOne(
            { accountId: userId, accountType, sessionId },
            { $set: { active: false, lastSeenAt: new Date() } }
        );
    } else {
        await userRepo.clearRefreshToken(userId, accountType);
    }
    return {
        success: true,
        message: 'تم تسجيل الخروج وإبطال الجلسة',
        serverTime: new Date().toISOString()
    };
};

module.exports = { login, refreshAccessToken, logout };
