const express = require('express');
const router = express.Router();
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const businessPortalService = require('../services/businessPortalService');
const { getClientReports } = require('../services/mobileWebParityService');
const { loadAdminReport } = require('../services/adminReportService');
const { generateAdminReportPdf } = require('../services/reportPdfService');
const { logAction } = require('../services/auditService');

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

const adminCopyPeriod = (source = {}) => {
    const dateType = String(source.dateType || 'month');
    const now = new Date();
    if (dateType === 'week') {
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const start = new Date(end);
        start.setDate(start.getDate() - 6);
        const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return { dateType: 'range', dateValue: '', dateFrom: format(start), dateTo: format(end) };
    }
    if (dateType === 'range') {
        return { dateType: 'range', dateValue: '', dateFrom: String(source.dateFrom || ''), dateTo: String(source.dateTo || '') };
    }
    const fallback = dateType === 'day'
        ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return { dateType: dateType === 'day' ? 'day' : 'month', dateValue: String(source.dateValue || fallback), dateFrom: '', dateTo: '' };
};

const adminCopyScope = async (req) => {
    const accountId = req.session.clientId;
    if (req.session.accountType === 'company') {
        const employee = await ClientEmployee.findById(accountId).select('companyId name canViewAllReports canManageCompany role').lean();
        if (!employee?.companyId) throw new Error('UNAUTHORIZED');
        const canViewAll = employee.canViewAllReports || employee.canManageCompany || employee.role === 'manager' || employee.role === 'owner' || employee.role === 'accountant';
        return {
            mainCategory: 'company',
            subId: String(employee.companyId),
            subType: canViewAll ? 'all' : String(employee.name || ''),
            forceToday: !canViewAll
        };
    }
    if (req.session.accountType === 'agent_staff') {
        const employee = await AgentEmployee.findById(accountId).select('agentId canViewAllReports canManageAgent role').lean();
        const canViewAll = employee?.canViewAllReports || employee?.canManageAgent || employee?.role === 'accountant';
        if (!employee?.agentId || !canViewAll) throw new Error('FORBIDDEN');
        return { mainCategory: 'agent', subId: String(employee.agentId), subType: 'all' };
    }
    if (req.session.accountType === 'sub_client') {
        const account = await SubAccount.findById(accountId).select('masterId').lean();
        if (!account?.masterId) throw new Error('UNAUTHORIZED');
        return { mainCategory: 'agent', subId: String(account.masterId), subType: String(accountId) };
    }
    return { mainCategory: 'direct_client', subId: String(accountId), subType: 'all' };
};

router.get('/reports/admin-copy.pdf', requireClientAuth, async (req, res) => {
    try {
        const scope = await adminCopyScope(req);
        const period = adminCopyPeriod(scope.forceToday ? { dateType: 'day' } : req.query);
        const { forceToday, ...reportScope } = scope;
        const input = { ...reportScope, ...period };
        const report = await loadAdminReport(input);
        const pdf = await generateAdminReportPdf(req.app, {
            report,
            generatedAt: new Date(),
            adminName: 'الإدارة المركزية'
        });
        const datePart = String(period.dateValue || `${period.dateFrom}-${period.dateTo}` || Date.now()).replace(/[^0-9-]/g, '');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length);
        res.setHeader('Content-Disposition', `attachment; filename="admin-report-copy-${datePart || Date.now()}.pdf"`);
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        logAction({
            action: 'CLIENT_ADMIN_REPORT_COPY_DOWNLOADED',
            req,
            performedById: req.session.clientId,
            performedByModel: req.session.accountType || 'User',
            targetId: scope.subId,
            targetModel: 'FinancialReport',
            metadata: { ...input, source: 'admin_report_service' },
            success: true,
            severity: 'info'
        }).catch(() => {});
        return res.end(pdf);
    } catch (error) {
        const status = error.message === 'FORBIDDEN' ? 403 : (error.code === 'PDF_BROWSER_NOT_FOUND' ? 503 : 500);
        return res.status(status).send(status === 403
            ? 'لا تملك صلاحية تنزيل التقرير المركزي لهذا الحساب.'
            : (status === 503 ? 'مولد تقرير الإدارة غير متاح حاليًا.' : 'تعذر إعداد نسخة تقرير الإدارة.'));
    }
});

module.exports = router;
