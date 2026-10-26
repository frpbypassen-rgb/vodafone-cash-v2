'use strict';
// The comprehensive administration statement contains the agency's full account.
const canReceiveAgencyStatement = workspace => Boolean(workspace?.isAgent
    && workspace.permissions?.canViewReports
    && workspace.permissions?.canViewBalance
    && workspace.permissions?.canViewAllReports);
module.exports = { canReceiveAgencyStatement };
