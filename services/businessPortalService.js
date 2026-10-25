'use strict';

// Compatibility facade. Domain ownership lives in portalWorkspace modules.
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');
const { buildAgentMobileNav } = require('../utils/customerPortalNav');
const { STATUS_META, SERVICE_CATALOG, PAGE_META, REPORT_SCOPES, COMPANY_REPORT_SCOPES, findServiceByToken } = require('./portalWorkspace/catalog');
const { resolveDateRange, safeNumber, formatInputDate } = require('./portalWorkspace/primitives');
const { resolveCompanyPermissions, canPostPortalTransfer, resolveWorkspace, canAccessPage, resolveClientPostLoginHref, redirectForbiddenPage } = require('./portalWorkspace/access');
const { buildNavigation, buildCompanyMobileNav } = require('./portalWorkspace/navigation');
const { resolvePortalHomeHref, forbiddenRedirectPath, buildLowBalanceAlert } = require('./portalWorkspace/presentation');
const { parseCompanyDepositSupportMessage, isCompanyDepositCreateIntent, canCreateCompanyDepositRequest } = require('./portalWorkspace/deposits');
const { ownershipFilter, buildTransactionFilter, summarizeTransactions } = require('./portalWorkspace/transactions');
const { getSettingsAndRates } = require('./portalWorkspace/settings');
const { buildReportGroups, buildReportAnalytics, loadReports, loadCentralCompanyReport } = require('./portalWorkspace/reports');
const { loadPageContext: loadWorkspacePageContext } = require('./portalWorkspace/context');
const loadPageContext = async (req, page) => loadWorkspacePageContext(req, page, await resolveWorkspace(req), canAccessPage);
const { loadCompanyHome } = require('./portalWorkspace/overview');

module.exports = { STATUS_META, SERVICE_CATALOG, PAGE_META, REPORT_SCOPES, COMPANY_REPORT_SCOPES, findServiceByToken, resolveDateRange, resolveCompanyPermissions, resolveAgentPermissions, canPostPortalTransfer, resolveWorkspace, canAccessPage, buildNavigation, buildCompanyMobileNav, buildAgentMobileNav, resolvePortalHomeHref, resolveClientPostLoginHref, forbiddenRedirectPath, redirectForbiddenPage, buildLowBalanceAlert, parseCompanyDepositSupportMessage, isCompanyDepositCreateIntent, canCreateCompanyDepositRequest, ownershipFilter, buildTransactionFilter, getSettingsAndRates, summarizeTransactions, buildReportGroups, buildReportAnalytics, loadPageContext, loadCompanyHome, loadReports, loadCentralCompanyReport, safeNumber, formatInputDate };
