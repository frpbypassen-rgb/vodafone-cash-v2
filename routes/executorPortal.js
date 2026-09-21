const express = require('express');
const router = express.Router();

// Controllers
const authController = require('../controllers/executorAuthController');
const dashboardController = require('../controllers/executorDashboardController');
const transactionController = require('../controllers/executorTransactionController');
const reportsController = require('../controllers/executorReportsController');

// Models
const executorSupportService = require('../services/executorSupportService');
const executorWebPushService = require('../services/executorWebPushService');
const { invalidateExecutorAuth, loadExecutorEmployee } = require('../services/executorAuthCache');

// Middlewares
const rejectExecutorSession = (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'ط§ظ†طھظ‡طھ ط¬ظ„ط³ط© ط§ظ„ط¯ط®ظˆظ„.' });
    }
    return res.redirect('/login');
};

const isExecutorReadRequest = (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

const loadPortalExecutor = async (req) => {
    const readRequest = isExecutorReadRequest(req);
    if (!readRequest) invalidateExecutorAuth(req.session.executorId);
    return loadExecutorEmployee(req.session.executorId, {
        fresh: !readRequest,
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
        if (!employee || employee.status !== 'active' || !employee.groupId || employee.groupId.status !== 'active') {
            invalidateExecutorAuth(req.session.executorId);
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
        const emp = await loadPortalExecutor(req);
        if (!emp || emp.status !== 'active' || !emp.groupId || emp.groupId.status !== 'active') {
            invalidateExecutorAuth(req.session.executorId);
            return rejectExecutorSession(req, res);
        }
        if (emp.role !== 'manager') {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ success: false, error: 'ظ‡ط°ظ‡ ط§ظ„طµظپط­ط© ظ…طھط§ط­ط© ظ„ظ…ط¯ظٹط± ط§ظ„ظ…ظ†ظپط° ظپظ‚ط·.' });
            }
            return res.redirect('/executor-portal/reports');
        }
        req.managerEmp = emp;
        return next();
    } catch (_) {
        return res.status(500).json({ success: false, error: 'ط­ط¯ط« ط®ط·ط£ ط£ط«ظ†ط§ط، ط§ظ„طھط­ظ‚ظ‚ ظ…ظ† ط§ظ„طµظ„ط§ط­ظٹط©.' });
    }
};

const requireExecutorTaskAccess = (req, res, next) => {
    const employee = req.executorEmployee;
    if (!employee || employee.role === 'accountant') {
        return res.status(403).json({ success: false, error: 'ظ‡ط°ط§ ط§ظ„ط­ط³ط§ط¨ ظ„ط§ ظٹظ…ظ„ظƒ طµظ„ط§ط­ظٹط© طھظ†ظپظٹط° ط§ظ„ط¹ظ…ظ„ظٹط§طھ.' });
    }
    return next();
};

const requireExecutorDepositAccess = (req, res, next) => {
    const employee = req.executorEmployee;
    if (!employee || !['manager', 'accountant', 'external'].includes(employee.role)) {
        return res.status(403).json({ success: false, error: 'ظ‡ط°ظ‡ ط§ظ„طµظپط­ط© ط؛ظٹط± ظ…طھط§ط­ط© ظ„ظ‡ط°ط§ ط§ظ„ط­ط³ط§ط¨.' });
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
// ط§ظ„ظ…ط³ط§ط± ط§ظ„ظ‚ط¯ظٹظ… ظƒط§ظ† ظٹظ†ط´ط¦ ط¥ظٹط¯ط§ط¹ط§ظ‹ ظ…ط¨ط§ط´ط±ط§ظ‹ ط¨ظ„ط§ ط¥ظٹطµط§ظ„ط§طھ. ظ†ظڈط¨ظ‚ظٹظ‡ ظ„ظ„طھظˆط§ظپظ‚طŒ
// ظ„ظƒظ† ظ†ظ…ط±ط±ظ‡ ط¥ظ„ظ‰ طھط¯ظپظ‚ ط§ظ„ظ…ط±ط§ط¬ط¹ط© ظ†ظپط³ظ‡ ط§ظ„ط°ظٹ ظٹظپط±ط¶ ط¥ط±ظپط§ظ‚ ط§ظ„ط¥ظٹطµط§ظ„ط§طھ.
router.post('/api/request-deposit', requireExecutorManager, dashboardController.postDepositRequest);
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
        return res.status(error.status || 500).json({ success: false, error: error.message || 'طھط¹ط°ط± ط¬ظ„ط¨ ط·ظ„ط¨ط§طھ ط§ظ„ط¯ط¹ظ….' });
    }
});
router.get('/api/support/group-chat', requireExecutorAuth, async (req, res) => {
    try {
        const workspace = await executorSupportService.getExecutorGroupChat({ executorId: req.executorEmployee._id });
        return res.json({ success: true, ...workspace, serverTime: new Date().toISOString() });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'طھط¹ط°ط± ظپطھط­ ظ…ط¬ظ…ظˆط¹ط© ط´ط±ظƒط© ط§ظ„طھظ†ظپظٹط°.' });
    }
});
router.post('/api/support/group-chat/replies', requireExecutorAuth, async (req, res) => {
    try {
        const workspace = await executorSupportService.replyToExecutorGroupChat({ executorId: req.executorEmployee._id, payload: req.body });
        req.app.get('io')?.emit('support:ticket-updated', { ticketId: workspace.ticket.id, channel: 'portal', direction: 'inbound', status: workspace.ticket.status, source: 'executor_group_chat' });
        return res.json({ success: true, ...workspace });
    } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message || 'طھط¹ط°ط± ط¥ط±ط³ط§ظ„ ط±ط³ط§ظ„ط© ط§ظ„ظ…ط¬ظ…ظˆط¹ط©.' });
    }
});
router.post('/api/support/tickets', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.createExecutorTicket({ executorId: req.executorEmployee._id, payload: req.body });
        req.app.get('io')?.emit('support:ticket-updated', { ticketId: ticket.id, channel: 'portal', direction: 'inbound', status: ticket.status, source: 'executor_web' });
        return res.status(201).json({ success: true, ticket });
    } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message || 'طھط¹ط°ط± ط¥ظ†ط´ط§ط، ط·ظ„ط¨ ط§ظ„ط¯ط¹ظ….' });
    }
});
router.get('/api/support/diagnostics', requireExecutorAuth, async (req, res) => {
    try {
        const diagnostics = await executorSupportService.getExecutorDiagnostics({ executorId: req.executorEmployee._id });
        return res.json({ success: true, diagnostics });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'طھط¹ط°ط± طھط´ط؛ظٹظ„ ط§ظ„ظپط­طµ.' });
    }
});
router.get('/api/support/tickets/:id', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.getExecutorTicket({ executorId: req.executorEmployee._id, ticketId: req.params.id });
        return res.json({ success: true, ticket });
    } catch (error) {
        return res.status(error.status || 404).json({ success: false, error: error.message || 'طھط¹ط°ط± ط¬ظ„ط¨ ط§ظ„ط·ظ„ط¨.' });
    }
});
router.post('/api/support/tickets/:id/replies', requireExecutorAuth, async (req, res) => {
    try {
        const ticket = await executorSupportService.replyToExecutorTicket({ executorId: req.executorEmployee._id, ticketId: req.params.id, payload: req.body });
        req.app.get('io')?.emit('support:ticket-updated', { ticketId: ticket.id, channel: 'portal', direction: 'inbound', status: ticket.status, source: 'executor_web' });
        return res.json({ success: true, ticket });
    } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message || 'طھط¹ط°ط± ط¥ط±ط³ط§ظ„ ط§ظ„ط±ط¯.' });
    }
});

// Browser Push for executor tasks. It shares the same audited audience as the mobile push worker.
router.get('/api/web-push/status', requireExecutorAuth, async (req, res) => {
    try {
        const status = await executorWebPushService.getExecutorWebPushStatus(req.executorEmployee._id);
        return res.json({ success: true, ...status });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'طھط¹ط°ط± ظپط­طµ ط¥ط´ط¹ط§ط±ط§طھ ط§ظ„ظ…طھطµظپط­.' });
    }
});
router.post('/api/web-push/subscribe', requireExecutorAuth, async (req, res) => {
    try {
        await executorWebPushService.upsertExecutorSubscription({ employeeId: req.executorEmployee._id, subscription: req.body?.subscription });
        return res.json({ success: true, subscribed: true });
    } catch (_) {
        return res.status(400).json({ success: false, error: 'ط¨ظٹط§ظ†ط§طھ ط§ط´طھط±ط§ظƒ ط§ظ„ط¥ط´ط¹ط§ط±ط§طھ ط؛ظٹط± طµط§ظ„ط­ط©.' });
    }
});
router.post('/api/web-push/unsubscribe', requireExecutorAuth, async (req, res) => {
    await executorWebPushService.disableExecutorSubscription({ employeeId: req.executorEmployee._id, endpoint: req.body?.endpoint });
    return res.json({ success: true, subscribed: false });
});
router.post('/api/web-push/test', requireExecutorAuth, async (req, res) => {
    try {
        const result = await executorWebPushService.sendExecutorWebPushTest(req.executorEmployee._id);
        if (!result.attempted) return res.status(409).json({ success: false, error: 'ظ„ط§ ظٹظˆط¬ط¯ ظ…طھطµظپط­ ظ…ط³ط¬ظ„ ظ„ط§ط³طھظ‚ط¨ط§ظ„ ط§ظ„ط§ط®طھط¨ط§ط±.' });
        if (!result.sent) return res.status(502).json({ success: false, error: 'ط±ظپط¶ ظ…ط²ظˆط¯ ط§ظ„ط¥ط´ط¹ط§ط±ط§طھ ط±ط³ط§ظ„ط© ط§ظ„ط§ط®طھط¨ط§ط±.' });
        return res.json({ success: true, ...result });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'طھط¹ط°ط± ط¥ط±ط³ط§ظ„ ط¥ط´ط¹ط§ط± ط§ظ„ط§ط®طھط¨ط§ط±.' });
    }
});

// --- Reports Routes ---
router.get('/reports', requireExecutorAuth, reportsController.getReports);

module.exports = router;
