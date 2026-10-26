'use strict';

// This policy belongs to agency accounts. Company capabilities are resolved
// independently by companyAccessService.
const resolveAgentPermissions = (actor = {}) => {
    const knownRole = ['agent', 'employee', 'accountant'].includes(actor?.role);
    const owner = actor?.role === 'agent';
    const accountant = actor?.role === 'accountant';
    const manager = knownRole && (owner || actor.canManageAgent === true);
    const custom = !owner && actor.staffPermissions;
    const capability = (key, fallback) => knownRole && (owner || (custom ? custom[key] === true : fallback));
    return {
        owner,
        manager,
        accountant,
        employee: knownRole && !manager && !accountant,
        canTransfer: !accountant && capability('canTransfer', true),
        canViewBalance: capability('canViewBalance', manager || accountant || actor.canViewAllReports === true),
        canManageCustomers: capability('canManageCustomers', manager),
        canManageStaff: capability('canManageStaff', actor.canCreateAgentStaff === true),
        canViewReports: knownRole,
        canViewAllReports: capability('canViewAllReports', manager || accountant || actor.canViewAllReports === true),
        canViewAllTransactions: capability('canViewAllTransactions', manager || accountant || actor.canViewAllReports === true),
        canEditSettings: owner || (!custom && manager),
        canInternalTransfer: !accountant && capability('canTransfer', true),
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
    if (page === 'finance') return access.canViewBalance === true && access.canViewAllTransactions === true;
    if (page === 'agency_profits') return access.canViewBalance === true && access.canViewAllReports === true;
    if (page === 'customer_profile') return access.canManageCustomers || access.canViewBalance && access.canViewAllReports;
    if (page === 'customers') return access.canManageCustomers === true;
    if (page === 'staff') return access.manager || access.accountant || access.canManageStaff;
    return page === 'reports' && access.canViewReports === true;
};

module.exports = { resolveAgentPermissions, dashboardPersona, canAccessAgentPage };
