'use strict';
// Compatibility facade: agency HTTP handlers have dedicated ownership.
const dashboard = require('./agent/dashboardController');
const staff = require('./agent/staffController');
const registration = require('./agent/registrationController');
const { resolveAgentPermissions, dashboardPersona } = require('../utils/agentPortalPolicy');
module.exports = {
    ...dashboard,
    postAddStaff: staff.postAddStaff,
    postToggleStaff: staff.postToggleStaff,
    postResetStaffPassword: staff.postResetStaffPassword,
    ...registration,
    agentRoleHelpers: {
        isAgentOwner: (actor) => resolveAgentPermissions(actor).owner,
        canManageAgent: (actor) => resolveAgentPermissions(actor).canManageCustomers,
        canCreateAgentStaff: (actor) => resolveAgentPermissions(actor).canManageStaff,
        canViewAgentBalance: (actor) => resolveAgentPermissions(actor).canViewBalance,
        canTransfer: (actor) => resolveAgentPermissions(actor).canTransfer,
        dashboardPersona,
        normalizeUsername: staff.normalizeUsername,
    },
};
