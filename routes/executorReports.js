const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');
const mobileWebParityService = require('../services/mobileWebParityService');
const mobileWebParityMapper = require('../mappers/mobileWebParityMapper');

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
    } catch (e) { res.status(500).send('Error'); }
});

router.post('/reports/filter', requireExecutorAuth, async (req, res) => {
    try {
        const emp = req.executorEmployee;
        if (!emp) return res.status(401).json({ error: 'Unauthorized' });
        const { dateType, dateValue } = req.body || {};
        const report = await mobileWebParityService.getExecutorReports({
            executorId: emp._id,
            dateType,
            dateValue,
            tenantId: req.tenant ? req.tenant._id : null
        });
        return res.json({ success: true, data: mobileWebParityMapper.toClientReportDto(report) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

module.exports = router;
