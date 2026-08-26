const express = require('express');
const router = express.Router();

// Controllers
const authController = require('../controllers/executorAuthController');
const dashboardController = require('../controllers/executorDashboardController');
const transactionController = require('../controllers/executorTransactionController');
const reportsController = require('../controllers/executorReportsController');

// Models
const Employee = require('../models/Employee');
const executorSupportService = require('../services/executorSupportService');
const executorWebPushService = require('../services/executorWebPushService');

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
        if (emp.role !== 'manager') {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ success: false, error: 'هذه الصفحة متاحة لمدير المنفذ فقط.' });
            }
            return res.redirect('/executor-portal/reports');
        }
        req.managerEmp = emp;
        return next();
    } catch (_) {
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء التحقق من الصلاحية.' });
    }
};

const requireExecutorTaskAccess = (req, res, next) => {
    const employee = req.executorEmployee;
    if (!employee || employee.role === 'accountant' || employee.role === 'external') {
        return res.status(403).json({ success: false, error: 'هذا الحساب لا يملك صلاحية تنفيذ العمليات.' });
    }
    return next();
};

router.get('/', (req, res) => {
    if (req.session.isExecutorLoggedIn && req.session.executorId) {
        return res.redirect('/executor-portal/dashboard');
    }
    return res.redirect('/login');
});

// --- Auth Routes ---
router.get('/login', authController.getLogin);
router.post('/login', authController.postLogin);
router.get('/register', authController.getRegister);
router.post('/register', authController.postRegister);
router.get('/verify', authController.getVerify);
router.post('/verify', authController.postVerify);
router.get('/logout', authController.logout);

// --- Dashboard Routes ---
router.get('/dashboard', requireExecutorAuth, dashboardController.getDashboard);
router.get('/settings', requireExecutorAuth, dashboardController.getSettings);
router.get('/deposits', requireExecutorManager, dashboardController.getDeposits);
router.get('/proxy/image/:id', requireExecutorAuth, dashboardController.getProxyImage);
router.get('/proxy/image/:id/:index', requireExecutorAuth, dashboardController.getProxyImage);
router.get('/proxy/executor-image/:id/:index', requireExecutorAuth, dashboardController.getProxyExecutorImage);
router.get('/api/overview', requireExecutorAuth, dashboardController.getOverview);
router.get('/api/live-tasks', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.getLiveTasks);
router.post('/api/clear-alert/:id', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.postClearAlert);
router.post('/api/clear-dep-alert/:id', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.postClearDepAlert);
router.get('/api/deposits', requireExecutorManager, dashboardController.getDepositRequests);
router.post('/api/deposits', requireExecutorManager, dashboardController.postDepositRequest);

// --- Employee Management Routes (Manager only) ---
router.get('/employees', requireExecutorManager, dashboardController.getEmployees);
router.get('/api/employees', requireExecutorManager, dashboardController.getEmployeesList);
router.post('/api/employees/create', requireExecutorManager, dashboardController.postEmployeesCreate);
router.patch('/api/employees/:id', requireExecutorManager, dashboardController.postEmployeesUpdate);
router.post('/api/employees/toggle/:id', requireExecutorManager, dashboardController.postEmployeesToggle);
router.post('/api/employees/toggle-reports/:id', requireExecutorManager, dashboardController.postEmployeesToggleReports);
router.post('/api/employees/reset-password/:id', requireExecutorManager, dashboardController.postEmployeesResetPassword);
router.post('/api/employees/delete/:id', requireExecutorManager, dashboardController.postEmployeesDelete);
router.post('/api/employees/external-transaction/:id', requireExecutorManager, dashboardController.postExternalEmployeeTransaction);
router.post('/api/task-routing-mode', requireExecutorManager, dashboardController.postTaskRoutingMode);
router.get('/api/route-candidates', requireExecutorManager, dashboardController.getRouteCandidates);
router.post('/api/route-task/:id', requireExecutorManager, dashboardController.postRouteTask);

// --- Transaction Routes ---
router.post('/api/request-deposit', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postRequestDeposit);
router.post('/api/accept-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postAcceptTask);
router.post('/api/edit-amount/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postEditAmount);
router.post('/api/cancel-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postCancelTask);
router.post('/api/return-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postReturnTask);
router.post('/api/complete-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postCompleteTask);
router.post('/api/zaynpay-execute/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.executeViaZaynPay);
router.post('/api/rate-task/:id', requireExecutorAuth, transactionController.postRateExecutor);
router.post('/api/voice-note/:id', requireExecutorAuth, transactionController.postVoiceNote);

// --- Support Routes ---
router.get('/support', requireExecutorAuth, transactionController.getSupport);
router.get('/api/support/messages', requireExecutorAuth, transactionController.getSupportMessages);
router.post('/api/support/messages', requireExecutorAuth, transactionController.postSupportMessages);
router.get('/api/support/tickets', requireExecutorAuth, async (req, res) => {
    try {
        const result = await executorSupportService.listExecutorTickets({
            executorId: req.executorEmployee._id,
            status: req.query.status,
            category: req.query.category,
            search: req.query.search,
            page: req.query.page,
            limit: req.query.limit
        });
        return res.json({ success: true, ...result, serverTime: new Date().toISOString() });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر جلب طلبات الدعم.' });
    }
});
router.get('/api/support/group-chat', requireExecutorAuth, async (req, res) => {
    try {
        const workspace = await executorSupportService.getExecutorGroupChat({ executorId: req.executorEmployee._id });
        return res.json({ success: true, ...workspace, serverTime: new Date().toISOString() });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر فتح مجموعة شركة التنفيذ.' });
    }
});
router.post('/api/support/group-chat/replies', requireExecutorAuth, async (req, res) => {
    try {
        const workspace = await executorSupportService.replyToExecutorGroupChat({ executorId: req.executorEmployee._id, payload: req.body });
        req.app.get('io')?.emit('support:ticket-updated', { ticketId: workspace.ticket.id, channel: 'portal', direction: 'inbound', status: workspace.ticket.status, source: 'executor_group_chat' });
        return res.json({ success: true, ...workspace });
    } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message || 'تعذر إرسال رسالة المجموعة.' });
    }
});
router.post('/api/support/tickets', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.createExecutorTicket({ executorId: req.executorEmployee._id, payload: req.body });
        req.app.get('io')?.emit('support:ticket-updated', { ticketId: ticket.id, channel: 'portal', direction: 'inbound', status: ticket.status, source: 'executor_web' });
        return res.status(201).json({ success: true, ticket });
    } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message || 'تعذر إنشاء طلب الدعم.' });
    }
});
router.get('/api/support/diagnostics', requireExecutorAuth, async (req, res) => {
    try {
        const diagnostics = await executorSupportService.getExecutorDiagnostics({ executorId: req.executorEmployee._id });
        return res.json({ success: true, diagnostics });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر تشغيل الفحص.' });
    }
});
router.get('/api/support/tickets/:id', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.getExecutorTicket({ executorId: req.executorEmployee._id, ticketId: req.params.id });
        return res.json({ success: true, ticket });
    } catch (error) {
        return res.status(error.status || 404).json({ success: false, error: error.message || 'تعذر جلب الطلب.' });
    }
});
router.post('/api/support/tickets/:id/replies', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.replyToExecutorTicket({ executorId: req.executorEmployee._id, ticketId: req.params.id, payload: req.body });
        req.app.get('io')?.emit('support:ticket-updated', { ticketId: ticket.id, channel: 'portal', direction: 'inbound', status: ticket.status, source: 'executor_web' });
        return res.json({ success: true, ticket });
    } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message || 'تعذر إرسال الرد.' });
    }
});

// Browser Push for executor tasks. It shares the same audited audience as the mobile push worker.
router.get('/api/web-push/status', requireExecutorAuth, async (req, res) => {
    try {
        const status = await executorWebPushService.getExecutorWebPushStatus(req.executorEmployee._id);
        return res.json({ success: true, ...status });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر فحص إشعارات المتصفح.' });
    }
});
router.post('/api/web-push/subscribe', requireExecutorAuth, async (req, res) => {
    try {
        await executorWebPushService.upsertExecutorSubscription({ employeeId: req.executorEmployee._id, subscription: req.body?.subscription });
        return res.json({ success: true, subscribed: true });
    } catch (_) {
        return res.status(400).json({ success: false, error: 'بيانات اشتراك الإشعارات غير صالحة.' });
    }
});
router.post('/api/web-push/unsubscribe', requireExecutorAuth, async (req, res) => {
    await executorWebPushService.disableExecutorSubscription({ employeeId: req.executorEmployee._id, endpoint: req.body?.endpoint });
    return res.json({ success: true, subscribed: false });
});
router.post('/api/web-push/test', requireExecutorAuth, async (req, res) => {
    try {
        const result = await executorWebPushService.sendExecutorWebPushTest(req.executorEmployee._id);
        if (!result.attempted) return res.status(409).json({ success: false, error: 'لا يوجد متصفح مسجل لاستقبال الاختبار.' });
        if (!result.sent) return res.status(502).json({ success: false, error: 'رفض مزود الإشعارات رسالة الاختبار.' });
        return res.json({ success: true, ...result });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر إرسال إشعار الاختبار.' });
    }
});

// --- Reports Routes ---
router.get('/reports', requireExecutorAuth, reportsController.getReports);

module.exports = router;
