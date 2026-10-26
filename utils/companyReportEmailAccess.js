'use strict';
const canReceiveCompanyStatement = workspace => Boolean(workspace?.isCompany && workspace.permissions?.canViewReports && workspace.permissions?.canViewBalance && (!workspace.permissions?.employee || workspace.permissions?.canViewAllReports));
module.exports = { canReceiveCompanyStatement };
