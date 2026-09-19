'use strict';

const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const {
    normalizeCompanyTheme,
    readStoredCompanyTheme
} = require('../utils/companyPortalTheme');

const CANONICAL_ROLES = Object.freeze(['owner', 'accountant', 'employee']);
const COMPANY_CAPABILITIES = Object.freeze([
    'canCreateTransfer',
    'canViewAllReports',
    'canManageCompanyProfile',
    'canManageTeam',
    'canResetStaffPassword',
    'canViewBalance',
    'canViewReports',
    'canInternalTransfer',
    'canRequestDeposit'
]);

const COMPANY_PAGE_CAPABILITY = Object.freeze({
    overview: 'canOpenOverview',
    transactions: 'canOpenWorkspace',
    settings: 'canOpenWorkspace',
    security: 'canOpenWorkspace',
    support: 'canOpenWorkspace',
    services: 'canCreateTransfer',
    service_workbench: 'canCreateTransfer',
    smart_transfer: 'canCreateTransfer',
    internal_transfer: 'canInternalTransfer',
    deposits: 'canRequestDeposit',
    finance: 'canViewBalance',
    staff: 'canViewTeam',
    reports: 'canViewReports'
});

const explicitFlag = (account, key) => {
    if (!account || account[key] === undefined || account[key] === null) return undefined;
    return account[key] === true;
};

const isLegacyOwner = (account) => {
    const role = String(account?.role || '').toLowerCase();
    return role !== 'accountant'
        && account?.canViewAllReports === true
        && account?.canManageCompany !== true;
};

const resolveCanonicalRole = (account = {}) => {
    const role = String(account.role || '').toLowerCase();
    const corporateRole = String(account.corporateRole || '').toLowerCase();
    if (role === 'owner' || account.canCreateCompanyStaff === true || isLegacyOwner(account)) {
        return 'owner';
    }
    if (role === 'accountant' || corporateRole === 'accountant') {
        return 'accountant';
    }
    return 'employee';
};

const resolveCompanyAccess = (account = {}) => {
    const role = resolveCanonicalRole(account);
    const owner = role === 'owner';
    const accountant = role === 'accountant';
    const operationalManager = owner
        || account.canManageCompany === true
        || (String(account.corporateRole || '').toLowerCase() === 'manager' && !accountant);
    const canCreateTransfer = explicitFlag(account, 'canCreateTransfer') ?? !accountant;
    const canViewAllReports = account.canViewAllReports === true;
    const canManageCompanyProfile = explicitFlag(account, 'canManageCompanyProfile')
        ?? (owner || account.canManageCompany === true || operationalManager);
    const canViewBalance = owner || operationalManager || accountant || canViewAllReports;
    const canViewReports = canViewBalance;
    const canManageTeam = owner;
    const canResetStaffPassword = owner;

    return Object.freeze({
        role,
        owner,
        manager: operationalManager,
        accountant,
        employee: !operationalManager && !accountant,
        canCreateTransfer,
        canViewAllReports,
        canManageCompanyProfile,
        canManageTeam,
        canResetStaffPassword,
        canViewBalance,
        canViewReports,
        canEditSettings: canManageCompanyProfile,
        canTransfer: canCreateTransfer,
        canInternalTransfer: canCreateTransfer && operationalManager,
        canRequestDeposit: operationalManager || accountant,
        canManageStaff: canManageTeam,
        canManageCustomers: false,
        canViewTeam: operationalManager || accountant,
        canOpenOverview: !(!operationalManager && !accountant),
        canOpenWorkspace: true
    });
};

const toPortalPermissions = (access) => ({
    owner: access.owner,
    manager: access.manager,
    accountant: access.accountant,
    employee: access.employee,
    canTransfer: access.canCreateTransfer,
    canViewBalance: access.canViewBalance,
    canManageCustomers: false,
    canManageStaff: access.canManageTeam,
    canViewReports: access.canViewReports,
    canEditSettings: access.canManageCompanyProfile,
    canInternalTransfer: access.canInternalTransfer,
    canRequestDeposit: access.canRequestDeposit,
    canCreateTransfer: access.canCreateTransfer,
    canManageCompanyProfile: access.canManageCompanyProfile,
    canViewAllReports: access.canViewAllReports,
    canManageTeam: access.canManageTeam,
    canResetStaffPassword: access.canResetStaffPassword,
    canViewTeam: access.canViewTeam,
    canOpenOverview: access.canOpenOverview,
    canOpenWorkspace: access.canOpenWorkspace,
    canonicalRole: access.role
});

const dashboardPersona = (account) => {
    const access = resolveCompanyAccess(account);
    if (access.accountant) return 'accountant';
    if (access.manager) return 'manager';
    return 'employee';
};

const canAccessCompanyPage = (access, page) => {
    const capability = COMPANY_PAGE_CAPABILITY[page];
    if (!capability || !access) return false;
    if (capability === 'canCreateTransfer') {
        return access.canCreateTransfer === true || access.canTransfer === true;
    }
    if (capability === 'canOpenOverview') {
        return access.canOpenOverview === true || access.employee === false;
    }
    if (capability === 'canOpenWorkspace') return access.canOpenWorkspace !== false;
    if (capability === 'canViewTeam') {
        return access.canViewTeam === true || access.manager === true || access.accountant === true;
    }
    return access[capability] === true;
};

const sameId = (left, right) => String(left || '') === String(right || '');

const assertSameCompany = (actorCompanyId, targetCompanyId) => {
    if (!actorCompanyId || !targetCompanyId || !sameId(actorCompanyId, targetCompanyId)) {
        const error = new Error('CROSS_COMPANY');
        error.statusCode = 403;
        error.code = 'CROSS_COMPANY';
        throw error;
    }
};

const assertNotSelf = (actorId, targetId) => {
    if (sameId(actorId, targetId)) {
        const error = new Error('SELF_TARGET_FORBIDDEN');
        error.statusCode = 403;
        error.code = 'SELF_TARGET_FORBIDDEN';
        throw error;
    }
};

const assertCapability = (access, capability) => {
    if (!access || access[capability] !== true) {
        const error = new Error('FORBIDDEN');
        error.statusCode = 403;
        error.code = 'FORBIDDEN';
        throw error;
    }
};

const createAccessError = (code, statusCode = 403) => {
    const error = new Error(code);
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const loadCompanyAccess = async (req, { preloadedAccount = null } = {}) => {
    if (!req?.session?.isClientLoggedIn || req.session.accountType !== 'company' || !req.session.clientId) {
        throw createAccessError('NOT_COMPANY_SESSION', 401);
    }

    const account = preloadedAccount || await ClientEmployee.findById(req.session.clientId);
    if (!account || account.status !== 'active') {
        throw createAccessError('INVALID_COMPANY_EMPLOYEE', 401);
    }

    if (req.session.clientSessionVersion !== undefined
        && Number(account.sessionVersion || 0) !== Number(req.session.clientSessionVersion || 0)) {
        throw createAccessError('SESSION_REVOKED', 401);
    }

    const company = await ClientCompany.findById(account.companyId);
    if (!company || company.status !== 'active') {
        throw createAccessError('INVALID_COMPANY', 401);
    }

    const access = resolveCompanyAccess(account);
    return {
        account,
        company,
        companyId: company._id,
        access,
        permissions: toPortalPermissions(access),
        role: access.role,
        theme: readStoredCompanyTheme(account) || normalizeCompanyTheme(req.session.companyTheme) || 'day'
    };
};

const findCompanyStaffTarget = async ({ companyId, targetId }) => {
    if (!companyId || !targetId) {
        throw createAccessError('FORBIDDEN');
    }
    const target = await ClientEmployee.findOne({ _id: targetId, companyId });
    if (!target) {
        throw createAccessError('CROSS_COMPANY');
    }
    return target;
};

module.exports = {
    CANONICAL_ROLES,
    COMPANY_CAPABILITIES,
    COMPANY_PAGE_CAPABILITY,
    isLegacyOwner,
    resolveCanonicalRole,
    resolveCompanyAccess,
    toPortalPermissions,
    dashboardPersona,
    canAccessCompanyPage,
    assertSameCompany,
    assertNotSelf,
    assertCapability,
    loadCompanyAccess,
    findCompanyStaffTarget,
    sameId
};
