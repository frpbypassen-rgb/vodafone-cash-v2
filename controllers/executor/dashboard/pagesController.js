const Employee = require('../../../models/Employee');
const Transaction = require('../../../models/Transaction');
const {
    executorRequestTenantScope,
    findOwnedAcceptedExecutorTask,
    taskGroupFilter,
} = require('../../../services/executorTaskRoutingService');
const mobileWebParityService = require('../../../services/mobileWebParityService');
const { readExecutorManualPolicy, toPublicExecutionPolicy } = require('../../../utils/executorManualPolicy');
const { loadPortalLiveTasks } = require('../../../services/executorLiveTasksService');
const {
    snapshotCompanyBalances,
    workingBalanceForEmployee,
} = require('../../../services/executorBalancePoolService');
const { objectIdString } = require('./access');

exports.getDashboard = async (req, res) => {
    const emp = req.executorEmployee || (await Employee.findById(req.session.executorId).populate('groupId'));
    if (emp?.role === 'accountant') return res.redirect('/executor-portal/reports');
    if (!req.activeTaskId && emp?._id && emp?.groupId) {
        const employeeId = objectIdString(emp);
        const activeQuery = {
            status: 'accepted',
            operatorId: employeeId,
            ...taskGroupFilter(objectIdString(emp.groupId)),
        };
        if (req.tenant?._id) activeQuery.tenantId = req.tenant._id;
        const activeTask = await Transaction.findOne(activeQuery);
        if (activeTask) return res.redirect(`/executor-portal/active-task/${activeTask._id}`);
    }
    const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
    delete req.session.showMfaEnableNotice;
    const companyBalances =
        emp?.role === 'manager' ? await snapshotCompanyBalances(emp.groupId).catch(() => null) : null;
    const workingBalance =
        emp?.role === 'external' ? await workingBalanceForEmployee(emp).catch(() => null) : null;
    res.render('executor/dashboard', {
        emp,
        showMfaNotice,
        activeTaskId: req.activeTaskId || null,
        companyBalances,
        workingBalance,
        executionPolicy: toPublicExecutionPolicy(readExecutorManualPolicy(emp?.groupId, emp)),
    });
};

exports.getActiveTask = async (req, res) => {
    if (!/^[0-9a-f]{24}$/i.test(String(req.params.id || ''))) {
        return res.redirect('/executor-portal/dashboard');
    }
    try {
        const task = await findOwnedAcceptedExecutorTask({
            transactionId: req.params.id,
            executor: req.executorEmployee,
            tenantId: req.tenant?._id || null,
        });
        if (!task) return res.redirect('/executor-portal/dashboard');
        req.activeTaskId = String(task._id);
        return exports.getDashboard(req, res);
    } catch (_) {
        return res.status(503).send('تعذر فتح العملية النشطة. حاول مرة أخرى.');
    }
};

exports.getOverview = async (req, res) => {
    try {
        const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
        const overview = await mobileWebParityService.getExecutorOverview({
            executorId: emp._id,
            tenantId: req.tenant ? req.tenant._id : null,
        });
        return res.json({ success: true, data: overview, serverTime: new Date().toISOString() });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر جلب بيانات حساب التنفيذ.' });
    }
};

exports.getLiveTasks = async (req, res) => {
    try {
        const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
        if (!emp) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const lite = req.query?.lite === '1' || req.query?.lite === 'true';
        const payload = await loadPortalLiveTasks({
            emp,
            includeCompletedList: !lite,
            tenantId: executorRequestTenantScope(req),
        });
        return res.json(payload);
    } catch (_) {
        res.status(500).json({ error: true });
    }
};

exports.postClearAlert = async (req, res) => {
    try {
        const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const alertFilter = {
            _id: req.params.id,
            $or: [{ executorGroupId: emp.groupId }, { managerGroupId: emp.groupId }],
        };
        const tenantScope = executorRequestTenantScope(req);
        if (tenantScope) alertFilter.tenantId = tenantScope;
        const result = await Transaction.updateOne(
            alertFilter,
            { $unset: { emergencyAlert: 1 } },
            { strict: false }
        );
        if (!result.matchedCount)
            return res.status(403).json({ success: false, error: 'لا تملك صلاحية تعديل هذا التنبيه.' });
        return res.json({ success: true });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر إغلاق التنبيه.' });
    }
};

exports.postClearDepAlert = async (req, res) => {
    try {
        const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const alertFilter = {
            _id: req.params.id,
            $or: [
                { operatorId: emp._id.toString() },
                { executorGroupId: emp.groupId },
                { managerGroupId: emp.groupId },
            ],
        };
        const tenantScope = executorRequestTenantScope(req);
        if (tenantScope) alertFilter.tenantId = tenantScope;
        const result = await Transaction.updateOne(
            alertFilter,
            { $unset: { executorWebAlert: 1 } },
            { strict: false }
        );
        if (!result.matchedCount)
            return res.status(403).json({ success: false, error: 'لا تملك صلاحية تعديل هذا التنبيه.' });
        return res.json({ success: true });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر إغلاق التنبيه.' });
    }
};
