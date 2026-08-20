// repositories/userRepository.js
// ===============================================
// 📦 طبقة الوصول للبيانات — إدارة المستخدمين
// ===============================================
'use strict';

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const ClientCompany = require('../models/ClientCompany');
const bcrypt = require('bcryptjs');

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Keep the mobile API aligned with the unified website login: users may enter
// either the stored username (for example user@ahram.com), its short form, or
// their phone number. Username matching is intentionally case-insensitive.
const credentialLookup = (username) => {
    const value = String(username || '').trim();
    const candidates = value.includes('@') ? [value] : [value, `${value}@ahram.com`];
    const usernameClauses = [...new Set(candidates.filter(Boolean))].map((candidate) => ({
        webUsername: new RegExp(`^${escapeRegex(candidate)}$`, 'i')
    }));
    return {
        $or: [
            ...usernameClauses,
            { phone: value }
        ]
    };
};

const allowsLegacyTenantlessRecords = () => (
    process.env.NODE_ENV !== 'production'
    && String(process.env.ALLOW_LEGACY_TENANTLESS_RECORDS || 'true').toLowerCase() === 'true'
);

const tenantValue = (tenantId) => (
    allowsLegacyTenantlessRecords()
        ? { $in: [tenantId, null] }
        : tenantId
);

// Tenantless records are accepted only in non-production migration/test
// environments. Production always uses an exact tenant match.
const applyTenantScope = (lookup, tenantId) => {
    if (!tenantId) return lookup;
    return {
        ...lookup,
        tenantId: tenantValue(tenantId)
    };
};

const findByIdWithTenant = (Model, userId, tenantId) => {
    if (!tenantId) return Model.findById(userId);
    return Model.findOne({ _id: userId, tenantId: tenantValue(tenantId) });
};

/**
 * البحث عن حساب بالـ credentials (الأولوية: Employee → ClientEmployee → User)
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{account, accountType, balance, telegramId, executorBotId}|null>}
 */
const findByCredentials = async (username, password, tenantId) => {
    const searchPass = password.trim();

    // 1. فحص المنفذ (Employee)
    const execQuery = applyTenantScope(credentialLookup(username), tenantId);
    const execDoc = await Employee.findOne(execQuery).populate('groupId');

    if (execDoc) {
        const isMatch = await _comparePassword(searchPass, execDoc.webPassword, Employee, execDoc._id);
        if (isMatch) {
            if (execDoc.status !== 'active') return { error: 'ACCOUNT_BANNED', accountType: 'executor' };
            const executorGroupId = execDoc.groupId ? execDoc.groupId._id : (execDoc.botId ? execDoc.botId._id : null);
            const balance = execDoc.groupId ? execDoc.groupId.balance : (execDoc.botId ? execDoc.botId.balance : 0);
            return {
                account: execDoc,
                accountType: 'executor',
                telegramId: execDoc.telegramId,
                executorGroupId,
                balance
            };
        }
    }

    // 2. فحص موظف الشركة (ClientEmployee)
    const empDoc = await ClientEmployee.findOne(applyTenantScope(credentialLookup(username), tenantId));

    if (empDoc) {
        const isMatch = await _comparePassword(searchPass, empDoc.webPassword, ClientEmployee, empDoc._id);
        if (isMatch) {
            if (empDoc.status !== 'active') return { error: 'ACCOUNT_BANNED', accountType: 'client_company' };
            const company = await findByIdWithTenant(ClientCompany, empDoc.companyId, tenantId);
            if (!company) return { error: 'ACCOUNT_BANNED', accountType: 'client_company' };
            return {
                account: empDoc,
                accountType: 'client_company',
                telegramId: empDoc.telegramId,
                executorBotId: null,
                balance: company ? company.balance : 0
            };
        }
    }

    // 3. فحص موظف الوكيل (AgentEmployee)
    const agentEmpDoc = await AgentEmployee.findOne(applyTenantScope(credentialLookup(username), tenantId));

    if (agentEmpDoc) {
        const isMatch = await _comparePassword(searchPass, agentEmpDoc.webPassword, AgentEmployee, agentEmpDoc._id);
        if (isMatch) {
            if (agentEmpDoc.status !== 'active') return { error: 'ACCOUNT_BANNED', accountType: 'agent_staff' };
            const agent = await findByIdWithTenant(User, agentEmpDoc.agentId, tenantId);
            if (!agent || agent.status !== 'active' || agent.role !== 'agent') {
                return { error: 'ACCOUNT_BANNED', accountType: 'agent_staff' };
            }
            return {
                account: agentEmpDoc,
                accountType: 'agent_staff',
                telegramId: null,
                executorBotId: null,
                balance: agent.balance
            };
        }
    }

    // 4. فحص العميل الفردي (User)
    const userQuery = applyTenantScope(credentialLookup(username), tenantId);
    const userDoc = await User.findOne(userQuery);

    if (userDoc) {
        const isMatch = await _comparePassword(searchPass, userDoc.webPassword, User, userDoc._id);
        if (isMatch) {
            if (userDoc.status !== 'active') return { error: 'ACCOUNT_BANNED', accountType: 'client_user' };
            return {
                account: userDoc,
                accountType: 'client_user',
                telegramId: userDoc.telegramId,
                executorBotId: null,
                balance: userDoc.balance
            };
        }
    }

    // 5. فحص الحساب التابع (SubAccount)
    const SubAccount = require('../models/SubAccount');
    const subQuery = applyTenantScope(credentialLookup(username), tenantId);
    const subDoc = await SubAccount.findOne(subQuery);

    if (subDoc) {
        const isMatch = await _comparePassword(searchPass, subDoc.webPassword, SubAccount, subDoc._id);
        if (isMatch) {
            if (subDoc.status !== 'active') return { error: 'ACCOUNT_BANNED', accountType: 'sub_client' };
            return {
                account: subDoc,
                accountType: 'sub_client',
                telegramId: null,
                executorBotId: null,
                balance: subDoc.balance
            };
        }
    }

    return null;
};

/**
 * مقارنة كلمة المرور مع دعم الـ migration التلقائي
 */
const _comparePassword = async (inputPass, storedPass, Model, docId) => {
    if (!storedPass) return false;

    if (storedPass.startsWith('$2')) {
        return bcrypt.compare(inputPass, storedPass);
    }

    // Legacy plaintext → auto-migrate
    if (inputPass === storedPass) {
        await Model.updateOne({ _id: docId }, { webPassword: await bcrypt.hash(inputPass, 12) });
        return true;
    }
    return false;
};

/**
 * جلب حساب بالمعرف والنوع
 */
const findById = async (userId, accountType, tenantId) => {
    const Model = _getModel(accountType);
    const query = findByIdWithTenant(Model, userId, tenantId);
    if (accountType === 'executor' && query && typeof query.populate === 'function') {
        return query.populate('groupId');
    }
    return query;
};

/**
 * تحديث refresh token
 */
const updateRefreshToken = async (userId, accountType, token) => {
    const Model = _getModel(accountType);
    return Model.updateOne({ _id: userId }, { $set: { refreshToken: token } }, { strict: false });
};

const rotateRefreshToken = async (userId, accountType, currentToken, nextToken) => {
    const Model = _getModel(accountType);
    return Model.updateOne(
        { _id: userId, refreshToken: currentToken },
        { $set: { refreshToken: nextToken } },
        { strict: false }
    );
};

/**
 * حذف refresh token (logout)
 */
const clearRefreshToken = async (userId, accountType) => {
    const Model = _getModel(accountType);
    return Model.updateOne({ _id: userId }, { $unset: { refreshToken: 1 } }, { strict: false });
};

/**
 * الحصول على الـ Model المناسب
 */
const _getModel = (accountType) => {
    switch (accountType) {
        case 'executor': return Employee;
        case 'client_company': return ClientEmployee;
        case 'agent_staff': return AgentEmployee;
        case 'sub_client': return require('../models/SubAccount');
        default: return User;
    }
};

/**
 * الحصول على اسم الـ Model
 */
const getModelName = (accountType) => {
    switch (accountType) {
        case 'executor': return 'Employee';
        case 'client_company': return 'ClientEmployee';
        case 'agent_staff': return 'AgentEmployee';
        case 'sub_client': return 'SubAccount';
        default: return 'User';
    }
};

module.exports = {
    findByCredentials,
    findById,
    updateRefreshToken,
    rotateRefreshToken,
    clearRefreshToken,
    getModelName,
    applyTenantScope,
    allowsLegacyTenantlessRecords
};
