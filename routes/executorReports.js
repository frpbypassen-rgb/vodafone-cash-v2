const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');
const mobileWebParityService = require('../services/mobileWebParityService');
const mobileWebParityMapper = require('../mappers/mobileWebParityMapper');
const { generateExecutorReportPdf } = require('../services/reportPdfService');

const reportErrorResponse = (res, error) => {
    const messages = {
        UNAUTHORIZED: ['انتهت جلسة الدخول.', 401],
        FORBIDDEN: ['لا تملك صلاحية عرض تقرير هذا الموظف.', 403],
        NOT_FOUND: ['الموظف غير موجود ضمن شركة التنفيذ.', 404],
        INVALID_PERIOD: ['الفترة غير صالحة أو تتجاوز سنة واحدة.', 422]
    };
    const known = messages[error?.message];
    if (known) return res.status(known[1]).json({ success: false, error: known[0] });
    console.error('[executor-reports]', error);
    return res.status(500).json({ success: false, error: 'تعذر تجهيز تقرير التنفيذ.' });
};

const reportInput = (body = {}) => ({
    dateType: body.dateType,
    dateValue: body.dateValue,
    dateFrom: body.dateFrom,
    dateTo: body.dateTo,
    employeeId: body.employeeId || null
});

const requireExecutorAuth = async (req, res, next) => {
    if (!req.session.isExecutorLoggedIn || !req.session.executorId) {
        return req.path.includes('/filter')
            ? res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' })
            : res.redirect('/login');
    }
    try {
        const employee = await Employee.findById(req.session.executorId).populate('groupId');
        if (!employee || employee.status !== 'active' || !employee.groupId || employee.groupId.status !== 'active') {
            return req.path.includes('/filter')
                ? res.status(401).json({ success: false, error: 'حساب المنفذ غير مفعل.' })
                : res.redirect('/login');
        }
        req.executorEmployee = employee;
        return next();
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر التحقق من الحساب.' });
    }
};

router.get('/reports', requireExecutorAuth, async (req, res) => {
    try {
        const emp = req.executorEmployee;
        res.render('executor/reports', { emp });
    } catch (_) { res.status(500).send('Error'); }
});

router.post('/reports/filter', requireExecutorAuth, async (req, res) => {
    try {
        const emp = req.executorEmployee;
        if (!emp) return res.status(401).json({ error: 'Unauthorized' });
        const input = reportInput(req.body);
        const report = await mobileWebParityService.getExecutorReports({
            executorId: emp._id,
            ...input,
            tenantId: req.tenant ? req.tenant._id : null
        });
        return res.json({
            success: true,
            data: mobileWebParityMapper.toClientReportDto(report),
            serverTime: new Date().toISOString()
        });
    } catch (error) {
        return reportErrorResponse(res, error);
    }
});

router.post('/reports/download.pdf', requireExecutorAuth, async (req, res) => {
    try {
        const report = await mobileWebParityService.getExecutorReports({
            executorId: req.executorEmployee._id,
            ...reportInput(req.body),
            tenantId: req.tenant ? req.tenant._id : null
        });
        const reportDto = mobileWebParityMapper.toClientReportDto(report);
        const pdf = await generateExecutorReportPdf(req.app, {
            report: reportDto,
            generatedAt: new Date()
        });
        const datePart = String(reportDto.reportPeriod?.value || Date.now()).replace(/[^0-9-]/g, '');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length);
        res.setHeader('Content-Disposition', `attachment; filename="executor-report-${datePart || Date.now()}.pdf"`);
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        return res.end(pdf);
    } catch (error) {
        if (error?.code === 'PDF_BROWSER_NOT_FOUND') {
            return res.status(503).json({ success: false, error: 'محرك PDF غير متوفر على الخادم.' });
        }
        return reportErrorResponse(res, error);
    }
});

module.exports = router;
