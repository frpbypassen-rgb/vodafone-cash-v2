const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { emitSupportTicketUpdate } = require('../services/supportRealtimeService');
const router = express.Router();
const settingsPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: 'محاولات كثيرة. أعد المحاولة بعد قليل.' }
});
const webPushTestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    keyGenerator: (req) => String(req.executorEmployee._id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: 'اختبارات إشعارات كثيرة. أعد المحاولة بعد قليل.' }
});

// Controllers
const authController = require('../controllers/executorAuthController');
const dashboardController = require('../controllers/executorDashboardController');
const transactionController = require('../controllers/executorTransactionController');
const reportsController = require('../controllers/executorReportsController');

// Services
const executorSupportService = require('../services/executorSupportService');
const { ExecutorSupportError } = executorSupportService;
const { logExecutorFailure } = require('../services/executorTransactionError');
const executorWebPushService = require('../services/executorWebPushService');
const { invalidateExecutorAuth, loadExecutorEmployee } = require('../services/executorAuthCache');

const supportErrorResponse = (res, error, fallback) => {
    if (error instanceof ExecutorSupportError) {
        return res.status(error.status).json({ success: false, error: error.message });
    }
    logExecutorFailure('support', error);
    return res.status(500).json({ success: false, error: fallback });
};

// Middlewares
const rejectExecutorSession = (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
    }
    return res.redirect('/login');
};

const isExecutorReadRequest = (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

const loadPortalExecutor = async (req) => {
    const readRequest = isExecutorReadRequest(req);
    return loadExecutorEmployee(req.session.executorId, {
        fresh: true,
        lean: readRequest
    });
};

const requireExecutorAuth = async (req, res, next) => {
    if (!req.session.isExecutorLoggedIn || !req.session.executorId) {
        return rejectExecutorSession(req, res);
    }
    if (req.session.mfaEnrollmentRequired) return res.redirect('/security/mfa-enroll');
    try {
        const employee = await loadPortalExecutor(req);
        if (!employee || employee.status !== 'active' || !employee.groupId || employee.groupId.status !== 'active'
            || Number(employee.sessionVersion || 0) !== Number(req.session.executorSessionVersion || 0)) {
            invalidateExecutorAuth(req.session.executorId);
            delete req.session.isExecutorLoggedIn;
            delete req.session.executorId;
            delete req.session.executorGroupId;
            delete req.session.executorSessionVersion;
            return rejectExecutorSession(req, res);
        }
        req.executorEmployee = employee;
        return next();
    } catch (error) {
        logExecutorFailure('session-check', error);
        return rejectExecutorSession(req, res);
    }
};

const requireExecutorManager = async (req, res, next) => {
    if (!req.session.isExecutorLoggedIn || !req.session.executorId) return rejectExecutorSession(req, res);
    try {
        const emp = await loadPortalExecutor(req);
        if (!emp || emp.status !== 'active' || !emp.groupId || emp.groupId.status !== 'active'
            || Number(emp.sessionVersion || 0) !== Number(req.session.executorSessionVersion || 0)) {
            invalidateExecutorAuth(req.session.executorId);
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
    } catch (error) {
        logExecutorFailure('manager-permission-check', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء التحقق من الصلاحية.' });
    }
};

const requireExecutorTaskAccess = (req, res, next) => {
    const employee = req.executorEmployee;
    if (!employee || employee.role === 'accountant') {
        return res.status(403).json({ success: false, error: 'هذا الحساب لا يملك صلاحية تنفيذ العمليات.' });
    }
    return next();
};

const requireExecutorDepositAccess = (req, res, next) => {
    const employee = req.executorEmployee;
    if (!employee || !['manager', 'accountant', 'external'].includes(employee.role)) {
        return res.status(403).json({ success: false, error: 'هذه الصفحة غير متاحة لهذا الحساب.' });
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
router.get('/active-task/:id', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.getActiveTask);
router.get('/settings', requireExecutorAuth, dashboardController.getSettings);
router.patch('/api/settings/profile', requireExecutorAuth, dashboardController.patchSettingsProfile);
router.post('/api/settings/password', requireExecutorAuth, settingsPasswordLimiter, dashboardController.postSettingsPassword);
router.get('/deposits', requireExecutorAuth, requireExecutorDepositAccess, dashboardController.getDeposits);
router.get('/proxy/image/:id', requireExecutorAuth, dashboardController.getProxyImage);
router.get('/proxy/image/:id/:index', requireExecutorAuth, dashboardController.getProxyImage);
router.get('/proxy/executor-image/:id/:index', requireExecutorAuth, dashboardController.getProxyExecutorImage);
router.get('/api/overview', requireExecutorAuth, dashboardController.getOverview);
router.get('/api/live-tasks', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.getLiveTasks);
router.post('/api/clear-alert/:id', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.postClearAlert);
router.post('/api/clear-dep-alert/:id', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.postClearDepAlert);
router.get('/api/deposits', requireExecutorAuth, requireExecutorDepositAccess, dashboardController.getDepositRequests);
router.post('/api/deposits', requireExecutorManager, dashboardController.postDepositRequest);
router.post('/api/deposits/:id/review', requireExecutorManager, dashboardController.postReviewAdminDeposit);

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
router.get('/api/balance-pools', requireExecutorManager, dashboardController.getBalancePools);
router.post('/api/balance-pools', requireExecutorManager, dashboardController.postBalancePoolCreate);
router.post('/api/balance-pools/:id/rename', requireExecutorManager, dashboardController.postBalancePoolRename);
router.post('/api/balance-pools/:id/members', requireExecutorManager, dashboardController.postBalancePoolAttach);
router.post('/api/balance-pools/:id/members/:employeeId/detach', requireExecutorManager, dashboardController.postBalancePoolDetach);
router.post('/api/balance-pools/:id/archive', requireExecutorManager, dashboardController.postBalancePoolArchive);
router.post('/api/task-routing-mode', requireExecutorManager, dashboardController.postTaskRoutingMode);
router.post('/api/execution-policy', requireExecutorManager, dashboardController.postExecutionPolicy);
router.post('/api/employees/:id/execution-policy', requireExecutorManager, dashboardController.postEmployeeExecutionPolicy);
router.put('/api/employees/:id/execution-policy', requireExecutorManager, dashboardController.postEmployeeExecutionPolicy);
router.get('/api/quick-execute', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.getQuickExecute);
router.put('/api/quick-execute', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.putQuickExecute);
router.post('/api/quick-execute/dial/:id', requireExecutorAuth, requireExecutorTaskAccess, dashboardController.postQuickExecuteDial);
router.get('/api/route-candidates', requireExecutorManager, dashboardController.getRouteCandidates);
router.post('/api/route-task/:id', requireExecutorManager, dashboardController.postRouteTask);

// --- Transaction Routes ---
// Keep the legacy URL on the same receipt-required review flow.
router.post('/api/request-deposit', requireExecutorManager, dashboardController.postDepositRequest);
router.post('/api/accept-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postAcceptTask);
router.post('/api/edit-amount/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postEditAmount);
router.post('/api/cancel-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postCancelTask);
router.post('/api/return-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postReturnTask);
router.post('/api/complete-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postCompleteTask);
router.post('/api/retry-part-proof/:id/:partId', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postRetryPartProof);
router.post('/api/zaynpay-execute/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.executeViaZaynPay);
router.post('/api/rate-task/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postRateExecutor);
router.post('/api/voice-note/:id', requireExecutorAuth, requireExecutorTaskAccess, transactionController.postVoiceNote);

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
        return supportErrorResponse(res, error, 'تعذر جلب طلبات الدعم.');
    }
});
router.get('/api/support/group-chat', requireExecutorAuth, async (req, res) => {
    try {
        const workspace = await executorSupportService.getExecutorGroupChat({ executorId: req.executorEmployee._id });
        return res.json({ success: true, ...workspace, serverTime: new Date().toISOString() });
    } catch (error) {
        return supportErrorResponse(res, error, 'تعذر فتح مجموعة شركة التنفيذ.');
    }
});
router.post('/api/support/group-chat/replies', requireExecutorAuth, async (req, res) => {
    try {
        const workspace = await executorSupportService.replyToExecutorGroupChat({ executorId: req.executorEmployee._id, payload: req.body });
        emitSupportTicketUpdate(req, { ticketId: workspace.ticket.id, channel: 'portal', direction: 'inbound', status: workspace.ticket.status, source: 'executor_group_chat' });
        return res.json({ success: true, ...workspace });
    } catch (error) {
        return supportErrorResponse(res, error, 'تعذر إرسال رسالة المجموعة.');
    }
});
router.post('/api/support/tickets', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.createExecutorTicket({ executorId: req.executorEmployee._id, payload: req.body });
        emitSupportTicketUpdate(req, { ticketId: ticket.id, channel: 'portal', direction: 'inbound', status: ticket.status, source: 'executor_web' });
        return res.status(201).json({ success: true, ticket });
    } catch (error) {
        return supportErrorResponse(res, error, 'تعذر إنشاء طلب الدعم.');
    }
});
router.get('/api/support/diagnostics', requireExecutorAuth, async (req, res) => {
    try {
        const diagnostics = await executorSupportService.getExecutorDiagnostics({ executorId: req.executorEmployee._id });
        return res.json({ success: true, diagnostics });
    } catch (error) {
        return supportErrorResponse(res, error, 'تعذر تشغيل الفحص.');
    }
});
router.get('/api/support/tickets/:id', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.getExecutorTicket({ executorId: req.executorEmployee._id, ticketId: req.params.id });
        return res.json({ success: true, ticket });
    } catch (error) {
        return supportErrorResponse(res, error, 'تعذر جلب الطلب.');
    }
});
router.post('/api/support/tickets/:id/replies', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.replyToExecutorTicket({ executorId: req.executorEmployee._id, ticketId: req.params.id, payload: req.body });
        emitSupportTicketUpdate(req, { ticketId: ticket.id, channel: 'portal', direction: 'inbound', status: ticket.status, source: 'executor_web' });
        return res.json({ success: true, ticket });
    } catch (error) {
        return supportErrorResponse(res, error, 'تعذر إرسال الرد.');
    }
});

// Browser Push for executor tasks. It shares the same audited audience as the mobile push worker.
router.get('/api/web-push/status', requireExecutorAuth, async (req, res) => {
    try {
        const status = await executorWebPushService.getExecutorWebPushStatus(req.executorEmployee._id);
        return res.json({ success: true, ...status });
    } catch (error) {
        logExecutorFailure('web-push-status', error);
        return res.status(500).json({ success: false, error: 'تعذر فحص إشعارات المتصفح.' });
    }
});
router.post('/api/web-push/subscribe', requireExecutorAuth, async (req, res) => {
    try {
        await executorWebPushService.upsertExecutorSubscription({ employeeId: req.executorEmployee._id, subscription: req.body?.subscription });
        return res.json({ success: true, subscribed: true });
    } catch (error) {
        if (error?.code === 'INVALID_WEB_PUSH_SUBSCRIPTION') {
            return res.status(400).json({ success: false, error: 'بيانات اشتراك الإشعارات غير صالحة.' });
        }
        if (error?.code === 'WEB_PUSH_SUBSCRIPTION_LIMIT') {
            return res.status(409).json({ success: false, error: 'بلغت الحد الأقصى للمتصفحات المسجلة.' });
        }
        logExecutorFailure('web-push-subscribe', error);
        return res.status(500).json({ success: false, error: 'تعذر تسجيل اشتراك الإشعارات.' });
    }
});
router.post('/api/web-push/unsubscribe', requireExecutorAuth, async (req, res) => {
    try {
        await executorWebPushService.disableExecutorSubscription({ employeeId: req.executorEmployee._id, endpoint: req.body?.endpoint });
        return res.json({ success: true, subscribed: false });
    } catch (error) {
        logExecutorFailure('web-push-unsubscribe', error);
        return res.status(500).json({ success: false, error: 'تعذر إلغاء اشتراك الإشعارات.' });
    }
});
router.post('/api/web-push/test', requireExecutorAuth, webPushTestLimiter, async (req, res) => {
    try {
        const result = await executorWebPushService.sendExecutorWebPushTest(req.executorEmployee._id);
        if (!result.attempted) return res.status(409).json({ success: false, error: 'لا يوجد متصفح مسجل لاستقبال الاختبار.' });
        if (!result.sent) return res.status(502).json({ success: false, error: 'رفض مزود الإشعارات رسالة الاختبار.' });
        return res.json({ success: true, ...result });
    } catch (error) {
        logExecutorFailure('web-push-test', error);
        return res.status(500).json({ success: false, error: 'تعذر إرسال إشعار الاختبار.' });
    }
});

// --- Reports Routes ---
router.get('/reports', requireExecutorAuth, reportsController.getReports);

module.exports = router;
