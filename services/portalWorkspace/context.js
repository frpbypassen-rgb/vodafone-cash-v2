'use strict';

const agencyFinanceService = require('../agencyFinanceService');
const { buildPendingRateAlertForClient } = require('../rateAlerts/rateAlertAudienceService');
const { resolveAccountCompanyTheme, COMPANY_PORTAL_THEME_META } = require('../../utils/companyPortalTheme');
const { resolveAccountClientTheme, CLIENT_PORTAL_THEME_META } = require('../../utils/clientPortalTheme');
const { buildAgentMobileNav } = require('../../utils/customerPortalNav');
const { STATUS_META, PAGE_META, COMPANY_PAGE_META, findServiceByToken } = require('./catalog');
const { formatInputDate, resolveDateRange } = require('./primitives');
const { buildNavigation, buildCompanyMobileNav } = require('./navigation');
const { getSettingsAndRates } = require('./settings');
const { resolvePortalHomeHref, buildLowBalanceAlert } = require('./presentation');
const { loadOverview, loadTransferHub, loadCompanyHome, loadTransactions } = require('./overview');
const { loadCustomers, loadStaff } = require('./customers');
const { loadFinance } = require('./finance');
const { loadReports } = require('./reports');
const { loadCompanyDeposits } = require('./deposits');

const buildBaseContext = async (req, page, workspace) => {
    const rates = await getSettingsAndRates(workspace, req.app);
    const pendingRateUpdate = await buildPendingRateAlertForClient({
        accountType: workspace.isCompany
            ? 'company'
            : workspace.actorModel === 'AgentEmployee'
              ? 'agent_staff'
              : 'user',
        clientId: workspace.actor._id,
        settings: rates.settings,
    });
    const pageMeta = {
        ...PAGE_META[page],
        ...(workspace.isCompany ? COMPANY_PAGE_META[page] || {} : {}),
    };
    if (workspace.isAgent && page === 'finance') {
        Object.assign(pageMeta, { title: 'السجل المالي', eyebrow: 'تتبّع الحركات المالية' });
    }
    if (workspace.forceToday) {
        if (page === 'overview') Object.assign(pageMeta, { title: 'الرئيسية', eyebrow: 'عمل اليوم' });
        if (page === 'transactions')
            Object.assign(pageMeta, { title: 'عمليات اليوم', eyebrow: 'المتابعة اليومية' });
        if (page === 'reports')
            Object.assign(pageMeta, { title: 'تقارير اليوم', eyebrow: 'ملخص اليوم الحالي' });
    }
    if (workspace.isCompany && page === 'finance' && workspace.persona === 'accountant') {
        Object.assign(pageMeta, { title: 'مكتب المحاسبة', eyebrow: 'رصيد وكشوف بلا تنفيذ' });
    }
    if (workspace.isCompany && page === 'deposits' && !workspace.permissions.manager) {
        Object.assign(pageMeta, { title: 'متابعة الإيداع', eyebrow: 'تمويل بانتظار الاعتماد' });
    }
    if (workspace.isCompany && page === 'services' && workspace.forceToday) {
        Object.assign(pageMeta, { title: 'اختر · راجع · أرسل', eyebrow: 'يوم التنفيذ' });
    }
    const navigation = buildNavigation(workspace, page);
    return {
        page,
        pageMeta,
        workspace,
        portalHomeHref: resolvePortalHomeHref(workspace),
        navigation,
        companyMobileNav: workspace.isCompany
            ? buildCompanyMobileNav(workspace, navigation)
            : buildAgentMobileNav(navigation, page).dock,
        customerMobileNav: workspace.isCompany ? null : buildAgentMobileNav(navigation, page),
        statusMeta: STATUS_META,
        serviceCatalog: rates.services,
        serviceRates: rates.serviceRates,
        ratesUpdatedAt: rates.ratesUpdatedAt,
        pendingRateUpdate,
        lowBalanceAlert: buildLowBalanceAlert(workspace),
        systemOpen: rates.settings.isManualClosed !== true,
        query: req.query || {},
        csrfToken: req.session.csrfToken || '',
        formatInputDate,
        now: new Date(),
        companyTheme: workspace.isCompany
            ? resolveAccountCompanyTheme(workspace.actor, req.session.companyTheme)
            : resolveAccountClientTheme(workspace.actor, req.session.clientTheme),
        companyThemeMeta: workspace.isCompany
            ? COMPANY_PORTAL_THEME_META[resolveAccountCompanyTheme(workspace.actor, req.session.companyTheme)]
            : COMPANY_PORTAL_THEME_META[resolveAccountClientTheme(workspace.actor, req.session.clientTheme)],
        clientTheme: workspace.isCompany
            ? null
            : resolveAccountClientTheme(workspace.actor, req.session.clientTheme),
        clientThemeMeta: workspace.isCompany
            ? null
            : CLIENT_PORTAL_THEME_META[resolveAccountClientTheme(workspace.actor, req.session.clientTheme)],
    };
};

const loadPageContext = async (req, page, workspace, canAccessPage) => {
    if (!canAccessPage(workspace, page)) {
        const error = new Error('FORBIDDEN_PAGE');
        error.statusCode = 403;
        throw error;
    }

    const context = await buildBaseContext(req, page, workspace);
    if (page === 'reports') {
        const reportQuery = {
            ...req.query,
            scope: req.portalReportScope || req.query.scope,
        };
        Object.assign(context, await loadReports(workspace, reportQuery));
        if (workspace.isCompany) {
            const staffScope = String(reportQuery.scope || '') === 'staff';
            context.navigation = context.navigation.map((item) => {
                if (item.key === 'reports') return { ...item, active: !staffScope };
                if (item.key === 'team_reports') return { ...item, active: staffScope };
                return item;
            });
        }
    }
    if (page === 'overview') Object.assign(context, await loadOverview(workspace));
    if ((workspace.isCompany || workspace.isAgent) && ['overview', 'services'].includes(page))
        context.companyHome = await loadCompanyHome(workspace);
    if (page === 'services') {
        context.servicePage = {
            mode: workspace.isCompany ? 'gallery' : 'combined',
            selectedService: req.query.service || 'vodafone',
        };
        if (workspace.isCompany && workspace.forceToday) {
            Object.assign(context, await loadOverview(workspace));
        }
        Object.assign(context, await loadTransferHub(workspace, context.servicePage.selectedService));
    }
    if (page === 'service_workbench') {
        const service = findServiceByToken(req.params.serviceKey);
        if (!service) {
            const error = new Error('SERVICE_NOT_FOUND');
            error.statusCode = 404;
            throw error;
        }
        context.servicePage = {
            mode: 'workbench',
            selectedService: service.key,
            isolated: true,
            slug: service.slug,
        };
        const liveService = context.serviceCatalog.find((item) => item.key === service.key) || service;
        context.pageMeta = {
            ...context.pageMeta,
            title: `منضدة ${liveService.label}`,
            eyebrow: 'خدمة معزولة',
            icon: liveService.icon,
        };
        Object.assign(context, await loadTransferHub(workspace, service.key));
    }
    if (page === 'smart_transfer') {
        context.servicePage = { selectedService: req.query.service || 'vodafone', mode: 'smart' };
    }
    if (page === 'internal_transfer') {
        context.servicePage = { mode: 'internal' };
    }
    if (page === 'deposits') Object.assign(context, await loadCompanyDeposits(workspace));
    if (page === 'transactions') Object.assign(context, await loadTransactions(workspace, req.query));
    if (page === 'finance') Object.assign(context, await loadFinance(workspace, req.query));
    if (
        ['agency_balances', 'agency_debts', 'agency_account', 'agency_position', 'agency_profits'].includes(
            page
        )
    ) {
        const range = resolveDateRange(req.query, { forceToday: workspace.forceToday });
        context.agencyFinance = await agencyFinanceService.loadAgencyFinance(workspace, { range });
        context.filters = range;
        if (page === 'agency_account') {
            context.filters = { ...range, type: ['credit', 'debit'].includes(req.query.type) ? req.query.type : '' };
        }
    }
    if (page === 'customer_profile') {
        const range = resolveDateRange(req.query, { forceToday: workspace.forceToday });
        context.customerProfile = await agencyFinanceService.loadCustomerProfile(workspace, req.params.id, {
            range,
            masterRates: context.serviceRates,
        });
        if (!context.customerProfile) {
            const error = new Error('CUSTOMER_NOT_FOUND');
            error.statusCode = 404;
            throw error;
        }
        context.filters = range;
    }
    if (page === 'customers') Object.assign(context, await loadCustomers(workspace));
    if (page === 'staff') Object.assign(context, await loadStaff(workspace, req.query));
    if (page === 'settings' || page === 'security')
        context.settingsData = { profile: workspace.entity.businessProfile || {} };
    return context;
};

module.exports = { buildBaseContext, loadPageContext };
