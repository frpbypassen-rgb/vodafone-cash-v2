'use strict';

const express = require('express');
const router = express.Router();
const ClientCompany = require('../models/ClientCompany');
const ExecutorGroup = require('../models/ExecutorGroup');
const SubAccount = require('../models/SubAccount');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { requireAuth } = require('../middlewares/auth');
const { loadAdminReport } = require('../services/adminReportService');
const { logAction } = require('../services/auditService');
const { generateAdminReportPdf } = require('../services/reportPdfService');

const reportInput = (source = {}) => ({
    mainCategory: String(source.mainCategory || ''),
    subId: String(source.subId || ''),
    subType: String(source.subType || 'all'),
    dateType: source.dateType === 'day' ? 'day' : 'month',
    dateValue: String(source.dateValue || '')
});

const reportError = (error) => {
    const known = {
        INVALID_REPORT_DATE: 'التاريخ المحدد غير صالح.',
        REPORT_SCOPE_REQUIRED: 'يرجى اختيار نوع الحساب والحساب المطلوب.',
        REPORT_ENTITY_NOT_FOUND: 'الحساب المطلوب غير موجود أو لم يعد متاحاً.',
        INVALID_REPORT_SCOPE: 'نوع التقرير المحدد غير مدعوم.'
    };
    return known[error?.message] || 'حدث خطأ أثناء معالجة التقرير.';
};

router.get('/reports', requireAuth, async (req, res) => {
    try {
        const [users, companies, masterIds, executors, apiExecutors] = await Promise.all([
            User.find({ role: 'user' }).select('_id name phone').lean(),
            ClientCompany.find().select('_id name phone').lean(),
            SubAccount.distinct('masterId'),
            ExecutorGroup.find({ isApiGroup: false }).select('_id name').lean(),
            ExecutorGroup.find({ isApiGroup: true }).select('_id name').lean()
        ]);
        const [agentUsers, agentCompanies] = await Promise.all([
            User.find({ _id: { $in: masterIds } }).select('_id name phone').lean(),
            ClientCompany.find({ _id: { $in: masterIds } }).select('_id name phone').lean()
        ]);
        const agents = [
            ...agentUsers.map((agent) => ({ ...agent, type: 'user' })),
            ...agentCompanies.map((agent) => ({ ...agent, type: 'company' }))
        ];

        await Promise.all([
            ...companies.map(async (company) => {
                company.employees = await Transaction.distinct('employeeName', { companyId: company._id });
            }),
            ...agents.map(async (agent) => {
                agent.subAccounts = await SubAccount.find({ masterId: agent._id }).select('_id name phone').lean();
            }),
            ...executors.map(async (executor) => {
                executor.employees = await Transaction.distinct('executorName', { executorGroupId: executor._id });
            })
        ]);

        return res.render('reports', {
            adminName: req.session.adminName,
            users,
            companies,
            agents,
            executors,
            apiExecutors
        });
    } catch (error) {
        console.error('[reports/page] failed:', error.stack || error.message);
        return res.status(500).send('تعذر تحميل صفحة التقارير.');
    }
});

router.post('/api/reports/filter', requireAuth, async (req, res) => {
    try {
        const report = await loadAdminReport(reportInput(req.body));
        return res.json(report);
    } catch (error) {
        console.error('[reports/filter] failed:', error.stack || error.message);
        return res.status(['INVALID_REPORT_DATE', 'REPORT_SCOPE_REQUIRED', 'INVALID_REPORT_SCOPE'].includes(error.message) ? 400 : 500)
            .json({ success: false, error: reportError(error) });
    }
});

router.get('/reports/download.pdf', requireAuth, async (req, res) => {
    try {
        const input = reportInput(req.query);
        const report = await loadAdminReport(input);
        const generatedAt = new Date();
        const pdf = await generateAdminReportPdf(req.app, {
            report,
            generatedAt,
            adminName: req.session.adminName || 'الإدارة'
        });
        const datePart = String(input.dateValue || generatedAt.toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
        const asciiName = `financial-report-${datePart || Date.now()}.pdf`;
        const arabicName = encodeURIComponent(`التقرير_المالي_${datePart || 'شامل'}.pdf`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length);
        res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${arabicName}`);
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');

        logAction({
            action: 'REPORT_PDF_EXPORTED',
            req,
            performedById: req.session.adminId,
            performedByModel: 'Admin',
            performedByName: req.session.adminName || 'الإدارة',
            targetId: input.subId,
            targetModel: 'FinancialReport',
            metadata: {
                mainCategory: input.mainCategory,
                subType: input.subType,
                dateType: input.dateType,
                dateValue: input.dateValue,
                completedOperations: report.stats.completedCount,
                cancelledOperations: report.stats.cancelledCount,
                postCloseChanges: report.closedDayChanges.length
            }
        }).catch(() => {});

        return res.end(pdf);
    } catch (error) {
        console.error('[reports/pdf] failed:', error.stack || error.message);
        const message = error.code === 'PDF_BROWSER_NOT_FOUND'
            ? 'تعذر تشغيل محرك PDF على الخادم. يجب ضبط PUPPETEER_EXECUTABLE_PATH إلى Chrome أو Chromium.'
            : reportError(error);
        return res.status(error.code === 'PDF_BROWSER_NOT_FOUND' ? 503 : 500).send(message);
    }
});

module.exports = router;
