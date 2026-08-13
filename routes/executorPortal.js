const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Controllers
const authController = require('../controllers/executorAuthController');
const dashboardController = require('../controllers/executorDashboardController');
const transactionController = require('../controllers/executorTransactionController');
const reportsController = require('../controllers/executorReportsController');

// Models
const Employee = require('../models/Employee');

// Middlewares
const rejectExecutorSession = (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
    }
    return res.redirect('/login');
};

const requireExecutorAuth = async (req, res, next) => {
    if (!req.session.isExecutorLoggedIn || !req.session.executorId) {
        return rejectExecutorSession(req, res);
    }
    try {
        const employee = await Employee.findById(req.session.executorId).populate('groupId');
        if (!employee || employee.status !== 'active' || !employee.groupId || employee.groupId.status !== 'active') {
            delete req.session.isExecutorLoggedIn;
            delete req.session.executorId;
            delete req.session.executorGroupId;
            return rejectExecutorSession(req, res);
        }
        req.executorEmployee = employee;
        return next();
    } catch (_) {
        return rejectExecutorSession(req, res);
    }
};

const requireExecutorManager = async (req, res, next) => {
    if (!req.session.isExecutorLoggedIn || !req.session.executorId) return rejectExecutorSession(req, res);
    try {
        const emp = await Employee.findById(req.session.executorId).populate('groupId');
        if (!emp || emp.status !== 'active' || !emp.groupId || emp.groupId.status !== 'active') {
            return rejectExecutorSession(req, res);
        }
        if (emp.role !== 'manager') return res.status(403).json({ success: false, error: 'هذه الصفحة متاحة لمدير المنفذ فقط.' });
        req.managerEmp = emp;
        return next();
    } catch (e) {
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء التحقق من الصلاحية.' });
    }
};

router.get('/', (req, res) => {
    if (req.session.isExecutorLoggedIn && req.session.executorId) {
        return res.redirect('/executor-portal/dashboard');
    }
    return res.redirect('/login');
});

// --- Auth Routes ---
router.get('/login', (req, res) => {
    if (req.session.isExecutorLoggedIn && req.session.executorId) {
        return res.redirect('/executor-portal/dashboard');
    }
    return res.redirect('/login');
});
router.post('/login', (req, res) => res.redirect(307, '/login'));
router.get('/register', authController.getRegister);
router.post('/register', authController.postRegister);
router.get('/verify', authController.getVerify);
router.post('/verify', authController.postVerify);
router.get('/logout', authController.logout);

// --- Dashboard Routes ---
router.get('/dashboard', requireExecutorAuth, dashboardController.getDashboard);
router.get('/proxy/image/:id', requireExecutorAuth, dashboardController.getProxyImage);
router.get('/proxy/image/:id/:index', requireExecutorAuth, dashboardController.getProxyImage);
router.get('/api/live-tasks', requireExecutorAuth, dashboardController.getLiveTasks);
router.post('/api/clear-alert/:id', requireExecutorAuth, dashboardController.postClearAlert);
router.post('/api/clear-dep-alert/:id', requireExecutorAuth, dashboardController.postClearDepAlert);

// --- Employee Management Routes (Manager only) ---
router.get('/employees', requireExecutorManager, dashboardController.getEmployees);
router.get('/api/employees', requireExecutorManager, dashboardController.getEmployeesList);
router.post('/api/employees/create', requireExecutorManager, dashboardController.postEmployeesCreate);
router.post('/api/employees/toggle/:id', requireExecutorManager, dashboardController.postEmployeesToggle);
router.post('/api/employees/toggle-reports/:id', requireExecutorManager, dashboardController.postEmployeesToggleReports);
router.post('/api/employees/reset-password/:id', requireExecutorManager, dashboardController.postEmployeesResetPassword);
router.post('/api/employees/delete/:id', requireExecutorManager, dashboardController.postEmployeesDelete);
router.post('/api/task-routing-mode', requireExecutorManager, dashboardController.postTaskRoutingMode);
router.get('/api/route-candidates', requireExecutorManager, dashboardController.getRouteCandidates);
router.post('/api/route-task/:id', requireExecutorManager, dashboardController.postRouteTask);

// --- Transaction Routes ---
router.post('/api/request-deposit', requireExecutorAuth, transactionController.postRequestDeposit);
router.post('/api/accept-task/:id', requireExecutorAuth, transactionController.postAcceptTask);
router.post('/api/edit-amount/:id', requireExecutorAuth, transactionController.postEditAmount);
router.post('/api/cancel-task/:id', requireExecutorAuth, transactionController.postCancelTask);
router.post('/api/return-task/:id', requireExecutorAuth, transactionController.postReturnTask);
router.post('/api/complete-task/:id', requireExecutorAuth, transactionController.postCompleteTask);
router.post('/api/zaynpay-execute/:id', requireExecutorAuth, transactionController.executeViaZaynPay);

// --- Support Routes ---
router.get('/support', requireExecutorAuth, transactionController.getSupport);
router.get('/api/support/messages', requireExecutorAuth, transactionController.getSupportMessages);
router.post('/api/support/messages', requireExecutorAuth, transactionController.postSupportMessages);

// --- Reports Routes ---
router.get('/reports', requireExecutorAuth, reportsController.getReports);

module.exports = router;
