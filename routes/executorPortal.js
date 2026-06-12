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
const requireExecutorAuth = (req, res, next) => {
    if (req.session.isExecutorLoggedIn && req.session.executorId) return next();
    res.redirect('/login');
};

const requireExecutorManager = async (req, res, next) => {
    if (!req.session.isExecutorLoggedIn || !req.session.executorId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    try {
        const emp = await Employee.findById(req.session.executorId);
        if (!emp || emp.role !== 'manager') return res.status(403).json({ success: false, error: 'Forbidden' });
        req.managerEmp = emp;
        next();
    } catch (e) {
        res.status(500).json({ success: false, error: 'Server error' });
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
router.get('/proxy/image/:id', dashboardController.getProxyImage);
router.get('/proxy/image/:id/:index', dashboardController.getProxyImage);
router.get('/api/live-tasks', dashboardController.getLiveTasks);
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
