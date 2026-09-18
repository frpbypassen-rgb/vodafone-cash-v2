'use strict';

const CORPORATE_ROLES = Object.freeze(['manager', 'employee', 'accountant']);

const ROLE_LABELS = Object.freeze({
    manager: 'مدير',
    employee: 'موظف',
    accountant: 'محاسب'
});

const isLegacyCompanyOwner = (actor) => {
    const role = String(actor?.role || '').toLowerCase();
    return role !== 'accountant'
        && actor?.canViewAllReports === true
        && actor?.canManageCompany !== true;
};

const resolveCorporateRole = (actor = {}) => {
    const explicit = String(actor.corporateRole || '').toLowerCase();
    if (CORPORATE_ROLES.includes(explicit)) return explicit;

    const role = String(actor.role || '').toLowerCase();
    if (role === 'accountant') return 'accountant';
    if (role === 'owner' || actor.canCreateCompanyStaff === true || actor.canManageCompany === true) {
        return 'manager';
    }
    if (isLegacyCompanyOwner(actor)) return 'manager';
    return 'employee';
};

const permissionsForRole = (role) => {
    const normalized = CORPORATE_ROLES.includes(role) ? role : 'employee';
    const matrix = {
        manager: {
            canApprove: true,
            canReject: true,
            canAddBeneficiaries: true,
            canAssignPermissions: true,
            canTransfer: true,
            canViewAllOps: true,
            canExport: true,
            canExportOwn: true,
            canAnnotate: true,
            canReconcile: false,
            canViewInsights: true,
            canUploadInvoices: false,
            canViewStaff: true
        },
        employee: {
            canApprove: false,
            canReject: false,
            canAddBeneficiaries: false,
            canAssignPermissions: false,
            canTransfer: true,
            canViewAllOps: false,
            canExport: false,
            canExportOwn: true,
            canAnnotate: false,
            canReconcile: false,
            canViewInsights: true,
            canUploadInvoices: false,
            canViewStaff: false
        },
        accountant: {
            canApprove: false,
            canReject: false,
            canAddBeneficiaries: false,
            canAssignPermissions: false,
            canTransfer: false,
            canViewAllOps: true,
            canExport: true,
            canExportOwn: true,
            canAnnotate: true,
            canReconcile: true,
            canViewInsights: true,
            canUploadInvoices: true,
            canViewStaff: true
        }
    };
    return { ...matrix[normalized], role: normalized };
};

const defaultLimitForRole = (role, profile = {}) => {
    if (role === 'manager') {
        const value = Number(profile.defaultManagerApprovalLimit);
        return Number.isFinite(value) ? value : 0;
    }
    if (role === 'employee') {
        const value = Number(profile.defaultEmployeeApprovalLimit);
        return Number.isFinite(value) ? value : 0;
    }
    return 0;
};

const resolveApprovalLimit = (actor = {}, profile = {}) => {
    const role = resolveCorporateRole(actor);
    if (actor.approvalLimit !== null && actor.approvalLimit !== undefined && actor.approvalLimit !== '') {
        const explicit = Number(actor.approvalLimit);
        if (Number.isFinite(explicit)) return explicit;
    }
    return defaultLimitForRole(role, profile);
};

const isCorporatePortalEnabled = ({ actor, company, profile }) => {
    if (actor && actor.corporatePortalEnabled === false) return false;
    if (profile && profile.enabled === true) return true;
    if (company?.corporatePortal?.enabled === true) return true;
    return Boolean(actor?.corporatePortalEnabled);
};

const assertRoleAllowed = (actorRole, allowedRoles = []) => {
    if (!allowedRoles.includes(actorRole)) {
        const error = new Error('CORPORATE_FORBIDDEN');
        error.code = 'CORPORATE_FORBIDDEN';
        error.statusCode = 403;
        throw error;
    }
};

const sameCompany = (left, right) => String(left || '') === String(right || '');

module.exports = {
    CORPORATE_ROLES,
    ROLE_LABELS,
    resolveCorporateRole,
    permissionsForRole,
    resolveApprovalLimit,
    defaultLimitForRole,
    isCorporatePortalEnabled,
    assertRoleAllowed,
    sameCompany,
    isLegacyCompanyOwner
};
