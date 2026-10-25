'use strict';

// This policy belongs to agency accounts. Company capabilities are resolved
// independently by companyAccessService.
const resolveAgentPermissions = (actor = {}) => {
    const knownRole = ['agent', 'employee', 'accountant'].includes(actor?.role);
    const owner = actor?.role === 'agent';
    const accountant = actor?.role === 'accountant';
    const manager = knownRole && (owner || actor.canManageAgent === true);
    return {
        owner,
        manager,
        accountant,
        employee: knownRole && !manager && !accountant,
        canTransfer: knownRole && !accountant,
        canViewBalance: knownRole && (owner || manager || accountant || actor.canViewAllReports === true),
        canManageCustomers: manager,
        canManageStaff: knownRole && (owner || actor.canCreateAgentStaff === true),
        canViewReports: knownRole,
        canViewAllReports: knownRole && (owner || manager || accountant || actor.canViewAllReports === true),
        canEditSettings: owner || manager,
        canInternalTransfer: knownRole && !accountant,
        canRequestDeposit: false,
    };
};

const dashboardPersona = (actor) => {
    const access = resolveAgentPermissions(actor);
    return access.accountant ? 'accountant' : access.manager ? 'manager' : 'employee';
};

const canAccessAgentPage = (workspace, page) => {
    if (!workspace?.isAgent || workspace.isCompany || !workspace.permissions) return false;
    const access = workspace.permissions;
    if (['overview', 'transactions', 'settings', 'security', 'support'].includes(page)) return true;
    if (['services', 'service_workbench', 'smart_transfer'].includes(page))
        return access.canTransfer === true;
    if (page === 'internal_transfer') return access.canInternalTransfer === true;
    if (
        [
            'finance',
            'agency_balances',
            'agency_debts',
            'agency_account',
            'agency_position',
            'agency_profits',
        ].includes(page)
    )
        return access.canViewBalance === true;
    if (page === 'customer_profile') return access.canViewBalance || access.canManageCustomers;
    if (page === 'customers') return access.canManageCustomers === true;
    if (page === 'staff') return access.manager || access.accountant;
    return page === 'reports' && access.canViewReports === true;
};

module.exports = { resolveAgentPermissions, dashboardPersona, canAccessAgentPage };
