const { logAction } = require('../services/auditService');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
const { escapeRegex } = require('../utils/helpers');

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const {
    ExecutorAccountError,
    normalizeExecutorPhone,
    normalizeExecutorUsername
} = require('../services/executorAccountService');
const {
    taskOwnershipFilter,
    listRouteCandidates,
    routeExecutorTask,
    routingErrorMessage
} = require('../services/executorTaskRoutingService');
const { toExecutorPortalTaskDto } = require('../utils/executorTaskPrivacy');
const mobileWebParityService = require('../services/mobileWebParityService');
const mobileWebParityMapper = require('../mappers/mobileWebParityMapper');

const COMPLETED_TODAY_LIMIT = 60;

const objectIdString = (value) => String(value?._id || value || '');
const belongsToGroup = (employee, group) => (
    Boolean(employee) && objectIdString(employee.groupId) === objectIdString(group)
);

exports.getProxyImage = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('Not found');
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        const employeeGroupId = objectIdString(emp?.groupId);
        const ownsExecutorTask = objectIdString(tx.executorGroupId) === employeeGroupId;
        const ownsManagerTask = objectIdString(tx.managerGroupId) === employeeGroupId;
        if (!emp || (!ownsExecutorTask && !ownsManagerTask)) {
             return res.status(403).send('Forbidden');
        }
        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        if (tx.proofImages && tx.proofImages.length > index) { photoId = tx.proofImages[index]; }
        else if (tx.proofImage && index === 0) { photoId = tx.proofImage; }
        if (!photoId) return res.status(404).send('No photo');

        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) { console.error(error); res.status(500).send('Server error'); }
};

exports.getDashboard = async (req, res) => {
    const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
    if (emp?.role === 'accountant') return res.redirect('/executor-portal/reports');
    res.render('executor/dashboard', { emp });
};

exports.getSettings = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        const overview = await mobileWebParityService.getExecutorOverview({
            executorId: emp._id,
            tenantId: req.tenant ? req.tenant._id : null
        });
        return res.render('executor/settings', { emp, overview });
    } catch (_) {
        return res.redirect('/executor-portal/dashboard');
    }
};

exports.getOverview = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        const overview = await mobileWebParityService.getExecutorOverview({
            executorId: emp._id,
            tenantId: req.tenant ? req.tenant._id : null
        });
        return res.json({ success: true, data: overview, serverTime: new Date().toISOString() });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر جلب بيانات حساب التنفيذ.' });
    }
};

// ===============================================
// 👥 إدارة الموظفين (للمدير فقط)
// ===============================================
exports.getEmployees = async (req, res) => {
    const emp = req.managerEmp || await Employee.findById(req.session.executorId).populate('groupId');
    res.render('executor/employees', { emp });
};

exports.getEmployeesList = async (req, res) => {
    try {
        const workspace = await mobileWebParityService.getEmployeesWorkspace({
            executorId: req.managerEmp._id,
            tenantId: req.tenant ? req.tenant._id : null
        });
        res.json({
            success: true,
            employees: workspace.employees.map((employee) => mobileWebParityMapper.toEmployeeDto(employee)),
            summary: workspace.summary
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

exports.postEmployeesUpdate = async (req, res) => {
    try {
        const updated = await mobileWebParityService.updateEmployeeProfile({
            executorId: req.managerEmp._id,
            targetId: req.params.id,
            name: req.body?.name,
            phone: req.body?.phone
        });
        return res.json({ success: true, employee: { id: String(updated._id), name: updated.name, phone: updated.phone } });
    } catch (error) {
        const status = error.message === 'NOT_FOUND' ? 404 : (error.message === 'FORBIDDEN' ? 403 : 400);
        return res.status(status).json({ success: false, error: 'تعذر تعديل بيانات الموظف.' });
    }
};

exports.postEmployeesCreate = async (req, res) => {
    try {
        const { name, phone, role, webUsername, webPassword } = req.body;
        const cleanName = String(name || '').trim();
        if (cleanName.length < 3 || !phone || !webUsername || !webPassword) {
            return res.status(400).json({ success: false, error: 'يرجى إدخال جميع البيانات المطلوبة.' });
        }
        if (!['operator', 'accountant'].includes(role)) {
            return res.status(400).json({ success: false, error: 'نوع الحساب غير صالح.' });
        }
        if (String(webPassword).length < 6) {
            return res.status(400).json({ success: false, error: 'كلمة المرور يجب ألا تقل عن 6 أحرف.' });
        }

        const finalUsername = normalizeExecutorUsername(webUsername);
        const finalPhone = normalizeExecutorPhone(phone);
        const existing = await Employee.exists({ webUsername: new RegExp(`^${escapeRegex(finalUsername)}$`, 'i') });
        if (existing) return res.status(409).json({ success: false, error: 'اسم الدخول مستخدم بالفعل.' });
        const createdEmp = await Employee.create({
            name: cleanName,
            phone: finalPhone,
            role,
            status: 'active',
            groupId: req.managerEmp.groupId,
            webUsername: finalUsername,
            webPassword
        });
        
        await logAction({
            action: 'USER_CREATED',
            req,
            performedById: req.session.executorId || (req.managerEmp ? req.managerEmp._id : null),
            performedByModel: 'Employee',
            performedByName: req.managerEmp ? req.managerEmp.name : 'مدير',
            targetId: createdEmp._id,
            targetModel: 'Employee',
            result: 'ناجح',
            metadata: { 
                role, 
                username: finalUsername, 
                actionLabel: role === 'accountant' ? 'انشاء حساب محاسب' : 'انشاء حساب موظف',
                name: name
            }
        });

        return res.json({ success: true, username: finalUsername });
    } catch (e) {
        console.error(e);
        const message = e instanceof ExecutorAccountError ? e.message : 'تعذر إنشاء حساب الموظف.';
        return res.status(400).json({ success: false, error: message });
    }
};

exports.postEmployeesToggle = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'الموظف غير موجود.' });
        if (!belongsToGroup(emp, req.managerEmp.groupId)) {
            return res.status(403).json({ success: false, error: 'لا يمكن تعديل موظف تابع لمنفذ آخر.' });
        }
        if (emp.role === 'manager') return res.json({ success: false, error: 'Cannot toggle manager' });
        emp.status = emp.status === 'active' ? 'suspended' : 'active';
        await emp.save();
        res.json({ success: true, newStatus: emp.status });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesToggleReports = async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'الموظف غير موجود.' });
        if (!belongsToGroup(emp, req.managerEmp.groupId)) {
            return res.status(403).json({ success: false, error: 'لا يمكن تعديل موظف تابع لمنفذ آخر.' });
        }
        if (emp.role === 'manager') return res.json({ success: false, error: 'Manager always has access' });
        emp.canViewAllReports = !emp.canViewAllReports;
        await emp.save();
        res.json({ success: true, canViewAllReports: emp.canViewAllReports });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesResetPassword = async (req, res) => {
    try {
        const newPassword = String(req.body.newPassword || '');
        if (newPassword.length < 6) return res.status(400).json({ success: false, error: 'كلمة المرور يجب ألا تقل عن 6 أحرف.' });
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'الموظف غير موجود.' });
        if (!belongsToGroup(emp, req.managerEmp.groupId)) {
            return res.status(403).json({ success: false, error: 'لا يمكن تعديل موظف تابع لمنفذ آخر.' });
        }
        if (emp.role === 'manager') return res.json({ success: false, error: 'Not allowed' });
        emp.webPassword = newPassword;
        await emp.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postEmployeesDelete = async (req, res) => {
    try {
        await mobileWebParityService.deleteEmployee({
            executorId: req.managerEmp._id,
            targetId: req.params.id
        });
        return res.json({ success: true, archived: true });
    } catch (error) {
        const status = error.message === 'NOT_FOUND' ? 404 : (error.message === 'FORBIDDEN' ? 403 : 400);
        return res.status(status).json({ success: false, error: 'تعذر أرشفة حساب الموظف.' });
    }
};

exports.postTaskRoutingMode = async (req, res) => {
    try {
        const group = await ExecutorGroup.findByIdAndUpdate(
            req.managerEmp.groupId,
            { $set: { manualTaskRoutingEnabled: Boolean(req.body?.enabled) } },
            { new: true }
        );
        if (!group) return res.status(404).json({ success: false, error: 'مجموعة التنفيذ غير موجودة.' });
        return res.json({ success: true, manualTaskRoutingEnabled: group.manualTaskRoutingEnabled });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر تحديث وضع التوجيه.' });
    }
};

exports.getRouteCandidates = async (req, res) => {
    try {
        const employees = await listRouteCandidates({ groupId: req.managerEmp.groupId });
        return res.json({ success: true, employees });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر جلب المنفذين المتاحين.' });
    }
};

exports.postRouteTask = async (req, res) => {
    try {
        const result = await routeExecutorTask({
            transactionId: req.params.id,
            manager: req.managerEmp,
            employeeId: req.body?.employeeId
        });
        if (!result.ok) {
            const status = result.code === 'ACTIVE_TASK_EXISTS' || result.code === 'TASK_UNAVAILABLE' ? 409 : 400;
            return res.status(status).json({ success: false, code: result.code, error: routingErrorMessage(result.code) });
        }
        return res.json({
            success: true,
            employee: { id: String(result.employee._id), name: result.employee.name }
        });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر توجيه العملية.' });
    }
};

// ===============================================
// 🚀 جلب الطلبات الحية + الإشعارات
// ===============================================
exports.getLiveTasks = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const filter = {
            ...taskOwnershipFilter(emp),
            status: { $in: ['processing', 'accepted'] }
        };
        const taskArrivalTime = (tx) => {
            const value = new Date(tx.executorReceivedAt || tx.createdAt || 0).getTime();
            return Number.isFinite(value) ? value : 0;
        };

        const tasks = await Transaction.find(filter).lean();
        tasks.sort((first, second) => taskArrivalTime(first) - taskArrivalTime(second));

        const now = Date.now();
        const notificationIds = tasks
            .filter((tx) => tx.status === 'processing' && !tx.notifiedExecutors)
            .map((tx) => tx._id);
        const delayedTaskIds = tasks
            .filter((tx) => tx.status === 'processing' && !tx.autoAlertFired && now - taskArrivalTime(tx) >= 120000)
            .map((tx) => tx._id);

        await Promise.all([
            notificationIds.length
                ? Transaction.updateMany(
                    { _id: { $in: notificationIds }, notifiedExecutors: { $ne: true } },
                    { $set: { notifiedExecutors: true } },
                    { strict: false }
                )
                : Promise.resolve(),
            delayedTaskIds.length
                ? Transaction.updateMany(
                    { _id: { $in: delayedTaskIds }, autoAlertFired: { $ne: true } },
                    { $set: { emergencyAlert: 'تأخير استجابة! الطلب تخطى 120 ثانية ولم يقبله أحد، يرجى سحبه فوراً!', autoAlertFired: true } },
                    { strict: false }
                )
                : Promise.resolve()
        ]);

        // 🟢 جلب العمليات التي تم تنفيذها اليوم
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        let completedTodayQuery = {
            status: 'completed',
            updatedAt: { $gte: startOfToday }
        };

        if (emp.role === 'manager') {
            // المدير يرى كل عمليات المجموعة المنفذة اليوم
            completedTodayQuery.$or = [
                { executorGroupId: emp.groupId },
                { managerGroupId: emp.groupId }
            ];
        } else {
            // الموظف العادي يرى عملياته فقط
            completedTodayQuery.operatorId = emp._id.toString();
        }

        const [alerts, depAlerts, completedToday, completedTodayStats] = await Promise.all([
            Transaction.find({
                ...taskOwnershipFilter(emp),
                emergencyAlert: { $exists: true, $ne: null },
                status: { $in: ['processing', 'accepted'] }
            }).lean(),
            Transaction.find({
                $or: [ { operatorId: emp._id.toString() }, { executorGroupId: emp.groupId }, { managerGroupId: emp.groupId } ],
                executorWebAlert: { $exists: true, $ne: null }
            }).lean(),
            Transaction.find(completedTodayQuery)
                .sort({ updatedAt: -1 })
                .limit(COMPLETED_TODAY_LIMIT)
                .select('customId amount transferType vodafoneNumber accountNumber updatedAt executorName')
                .lean(),
            Transaction.aggregate([
                { $match: completedTodayQuery },
                { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } }
            ])
        ]);

        const completedTodaySummary = completedTodayStats[0] || { count: 0, amount: 0 };
        res.json({
            tasks: tasks.map((tx) => toExecutorPortalTaskDto(tx, emp._id)),
            alerts: alerts.map((tx) => toExecutorPortalTaskDto(tx, emp._id)),
            depAlerts: depAlerts.map((tx) => ({
                _id: String(tx._id),
                executorWebAlert: tx.executorWebAlert || null
            })),
            completedToday,
            completedTodaySummary,
            manualTaskRoutingEnabled: Boolean(emp.groupId?.manualTaskRoutingEnabled),
            canRouteTasks: emp.role === 'manager'
        });
    } catch (_) { res.status(500).json({ error: true }); }
};

exports.postClearAlert = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const result = await Transaction.updateOne({
            _id: req.params.id,
            $or: [{ executorGroupId: emp.groupId }, { managerGroupId: emp.groupId }]
        }, { $unset: { emergencyAlert: 1 } }, { strict: false });
        if (!result.matchedCount) return res.status(403).json({ success: false, error: 'لا تملك صلاحية تعديل هذا التنبيه.' });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ success: false, error: 'تعذر إغلاق التنبيه.' }); }
};

exports.postClearDepAlert = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const result = await Transaction.updateOne({
            _id: req.params.id,
            $or: [
                { operatorId: emp._id.toString() },
                { executorGroupId: emp.groupId },
                { managerGroupId: emp.groupId }
            ]
        }, { $unset: { executorWebAlert: 1 } }, { strict: false });
        if (!result.matchedCount) return res.status(403).json({ success: false, error: 'لا تملك صلاحية تعديل هذا التنبيه.' });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ success: false, error: 'تعذر إغلاق التنبيه.' }); }
};
