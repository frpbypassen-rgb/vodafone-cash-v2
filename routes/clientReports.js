const express = require('express');
const router = express.Router();
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const businessPortalService = require('../services/businessPortalService');
const { getClientReports } = require('../services/mobileWebParityService');

const requireClientAuth = async (req, res, next) => {
    try {
        if (!req.session.isClientLoggedIn || !req.session.clientId) return res.redirect('/client/login');

        if (req.session.accountType === 'company') {
            const employee = await ClientEmployee.findById(req.session.clientId).select('status companyId').lean();
            if (!employee || employee.status !== 'active') return res.redirect('/client/logout');

            const company = await ClientCompany.findById(employee.companyId).select('status').lean();
            if (!company || company.status !== 'active') return res.redirect('/client/logout');
            return next();
        }

        if (req.session.accountType === 'agent_staff') {
            const employee = await AgentEmployee.findById(req.session.clientId).select('status agentId').lean();
            if (!employee || employee.status !== 'active') return res.redirect('/client/logout');

            const agent = await User.findById(employee.agentId).select('status role').lean();
            if (!agent || agent.status !== 'active' || agent.role !== 'agent') return res.redirect('/client/logout');
            return next();
        }

        if (req.session.accountType === 'sub_client') {
            const subAccount = await SubAccount.findById(req.session.clientId).select('status').lean();
            if (!subAccount || subAccount.status !== 'active') return res.redirect('/client/logout');
            return next();
        }

        const user = await User.findById(req.session.clientId).select('status').lean();
        if (!user || user.status !== 'active') return res.redirect('/client/logout');
        return next();
    } catch (_error) {
        return res.redirect('/client/logout');
    }
};

const renderReports = async (req, res) => {
    try {
        const context = await businessPortalService.loadPageContext(req, 'reports');
        return res.render('client/workspace', context);
    } catch (error) {
        if (error.message !== 'NOT_BUSINESS_PORTAL') {
            if (error.message === 'FORBIDDEN_PAGE') {
                return businessPortalService.redirectForbiddenPage(req, res);
            }
            console.error('[Reports] workspace render failed:', error.message);
            return res.redirect('/client/logout');
        }
    }

    try {
        const isCompanyEmployee = req.session.accountType === 'company';
        const isAgentStaff = req.session.accountType === 'agent_staff';
        const isSubAccount = req.session.accountType === 'sub_client';
        let account;
        let canViewBalance = true;

        if (isCompanyEmployee) {
            account = await ClientEmployee.findById(req.session.clientId).lean();
            if (account) {
                const company = await ClientCompany.findById(account.companyId).lean();
                account.balance = company ? company.balance : 0;
                canViewBalance = account.canViewAllReports;
            }
        } else if (isAgentStaff) {
            account = await AgentEmployee.findById(req.session.clientId).lean();
            if (account) {
                const agent = await User.findById(account.agentId).lean();
                account.balance = agent ? agent.balance : 0;
                canViewBalance = account.canViewAllReports || account.canManageAgent || account.role === 'accountant';
            }
        } else if (isSubAccount) {
            account = await SubAccount.findById(req.session.clientId).lean();
        } else {
            account = await User.findById(req.session.clientId).lean();
        }

        if (!account) return res.redirect('/client/logout');
        account.canViewBalance = canViewBalance;
        return res.render('client/reports', { account, accountType: req.session.accountType });
    } catch (e) {
        console.error('Reports Render Error:', e);
        return res.redirect('/client/dashboard');
    }
};

router.get('/reports/staff', requireClientAuth, (req, res) => {
    req.portalReportScope = 'staff';
    return renderReports(req, res);
});

router.get('/reports', requireClientAuth, renderReports);

router.post('/reports/filter', requireClientAuth, async (req, res) => {
    try {
        const reportInput = req.body || {};
        const accountType = req.session.accountType === 'company' ? 'client_company' : req.session.accountType;
        const now = new Date();
        const defaultDateType = reportInput.dateType || 'month';
        const defaultDateValue = reportInput.dateValue || (
            defaultDateType === 'month'
                ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
                : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        );

        const reportData = await getClientReports({
            userId: req.session.clientId,
            accountType,
            dateType: defaultDateType,
            dateValue: defaultDateValue,
            dateFrom: reportInput.dateFrom,
            dateTo: reportInput.dateTo,
            search: reportInput.search,
            tenantId: req.tenantId
        });

        return res.json({ success: true, data: reportData });
    } catch (e) {
        console.error('Reports Filter Error:', e);
        return res.status(500).json({ success: false, error: e.message || 'Internal Server Error' });
    }
});

module.exports = router;
