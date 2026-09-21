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
    listRouteCandidates,
    routeExecutorTask,
    routingErrorMessage
} = require('../services/executorTaskRoutingService');
const mobileWebParityService = require('../services/mobileWebParityService');
const mobileWebParityMapper = require('../mappers/mobileWebParityMapper');
const { clearExecutorAuthCache } = require('../services/executorAuthCache');
const { readExecutorManualPolicy, toPublicExecutionPolicy } = require('../utils/executorManualPolicy');
const executorDepositRequestService = require('../services/executorDepositRequestService');
const { loadPortalLiveTasks } = require('../services/executorLiveTasksService');
const { getExecutorServiceLabel } = require('../utils/executorServiceCatalog');
const {
    ExecutorBalancePoolError,
    archivePool,
    attachMembers,
    createPool,
    detachMember,
    fundExternalExecutor,
    listExternalBalanceWorkspace,
    renamePool,
    snapshotCompanyBalances,
    workingBalanceForEmployee
} = require('../services/executorBalancePoolService');

const objectIdString = (value) => String(value?._id || value || '');
const belongsToGroup = (employee, group) => (
    Boolean(employee) && objectIdString(employee.groupId) === objectIdString(group)
);

const poolErrorResponse = (res, error) => {
    if (error instanceof ExecutorBalancePoolError) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
    }
    console.error(error);
    return res.status(500).json({ success: false, error: 'تعذر إكمال العملية.' });
};

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

exports.getProxyExecutorImage = async (req, res) => {
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
        const photoId = Array.isArray(tx.executorProofImages) && tx.executorProofImages.length > index ? tx.executorProofImages[index] : null;
        if (!photoId) return res.status(404).send('No photo');

        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) { console.error(error); res.status(500).send('Server error'); }
};

exports.getDashboard = async (req, res) => {
    const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
    if (emp?.role === 'accountant') return res.redirect('/executor-portal/reports');
    const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
    delete req.session.showMfaEnableNotice;
    const companyBalances = emp?.role === 'manager'
        ? await snapshotCompanyBalances(emp.groupId).catch(() => null)
        : null;
    const workingBalance = emp?.role === 'external'
        ? await workingBalanceForEmployee(emp).catch(() => null)
        : null;
    res.render('executor/dashboard', {
        emp,
        showMfaNotice,
        companyBalances,
        workingBalance,
        executionPolicy: toPublicExecutionPolicy(readExecutorManualPolicy(emp?.groupId, emp))
    });
};

exports.getSettings = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        const overview = await mobileWebParityService.getExecutorOverview({
            executorId: emp._id,
            tenantId: req.tenant ? req.tenant._id : null
        });
        const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
        delete req.session.showMfaEnableNotice;
        const companyBalances = overview.company
            ? {
                privateBalance: Number(overview.company.privateBalance ?? overview.company.balance ?? 0),
                totalBalance: Number(overview.company.totalBalance ?? overview.company.balance ?? 0),
                allocatedBalance: Number(overview.company.allocatedBalance || 0),
                multiService: Boolean(overview.company.multiService),
                byService: Array.isArray(overview.company.serviceBalances) ? overview.company.serviceBalances : []
            }
            : null;
        return res.render('executor/settings', {
            emp,
            overview,
            showMfaNotice,
            companyBalances,
            serviceLabel: getExecutorServiceLabel(overview.company?.serviceKey || emp.groupId?.serviceKey)
        });
    } catch (_) {
        return res.redirect('/executor-portal/dashboard');
    }
};

exports.getDeposits = async (req, res) => {
    const emp = req.managerEmp || req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
    if (!emp || !['manager', 'accountant', 'external'].includes(emp.role)) return res.redirect('/executor-portal/reports');
    const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
    delete req.session.showMfaEnableNotice;
    const workingBalance = emp.role === 'external'
        ? await workingBalanceForEmployee(emp).catch(() => ({ kind: 'solo', balance: Number(emp.balance || 0), pool: null }))
        : null;
    const companyBalances = ['manager', 'accountant'].includes(emp.role)
        ? await snapshotCompanyBalances(emp.groupId).catch(() => null)
        : null;
    return res.render('executor/deposits', {
        emp,
        showMfaNotice,
        depositScope: emp.role === 'external' ? 'external' : 'company',
        workingBalance,
        companyBalances
    });
};

exports.getDepositRequests = async (req, res) => {
    try {
        const requests = await executorDepositRequestService.listDepositRequests({ employee: req.managerEmp || req.executorEmployee });
        return res.json({ success: true, requests });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر تحميل طلبات الإيداع.' });
    }
};

exports.postDepositRequest = async (req, res) => {
    try {
        const request = await executorDepositRequestService.createDepositRequest({
            employee: req.managerEmp || req.executorEmployee,
            amount: req.body?.amount,
            note: req.body?.note,
            receipts: req.body?.receiptsBase64
        });
        req.app.get('io')?.emit('support:ticket-updated', { source: 'executor_deposit_request' });
        return res.status(201).json({ success: true, request, message: 'تم إرسال طلب الإيداع للدعم للمراجعة.' });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر إرسال طلب الإيداع.' });
    }
};

exports.postReviewAdminDeposit = async (req, res) => {
    try {
        const decision = String(req.body?.decision || '');
        if (!['approve', 'reject'].includes(decision)) return res.status(422).json({ success: false, error: 'قرار المراجعة غير صالح.' });
        const result = await executorDepositRequestService.reviewAdminDepositRequest({ employee: req.managerEmp || req.executorEmployee, requestId: req.params.id, approved: decision === 'approve', reason: req.body?.reason });
        req.app.get('io')?.emit('support:ticket-updated', { source: 'executor_admin_deposit_review' });
        return res.json({ success: true, status: decision === 'approve' ? 'approved' : 'rejected', requestId: String(result.transaction._id) });
    } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message || 'تعذر مراجعة طلب الإيداع.' });
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
    const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
    delete req.session.showMfaEnableNotice;
    const companyBalances = await snapshotCompanyBalances(emp.groupId).catch(() => null);
    res.render('executor/employees', { emp, showMfaNotice, companyBalances });
};

exports.getEmployeesList = async (req, res) => {
    try {
        const workspace = await mobileWebParityService.getEmployeesWorkspace({
            executorId: req.managerEmp._id,
            tenantId: req.tenant ? req.tenant._id : null
        });
        const pools = await listExternalBalanceWorkspace({ manager: req.managerEmp }).catch(() => null);
        res.json({
            success: true,
            employees: workspace.employees.map((employee) => mobileWebParityMapper.toEmployeeDto(employee)),
            summary: {
                ...workspace.summary,
                ...(pools?.balances || {})
            },
            pools: pools?.pools || [],
            soloExternals: pools?.solos || [],
            companyExecutionPolicy: workspace.companyExecutionPolicy || null
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
        if (!['operator', 'accountant', 'external'].includes(role)) {
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

        let poolAttachError = null;
        if (role === 'external' && String(req.body?.balancePoolId || '').trim()) {
            try {
                await attachMembers({
                    manager: req.managerEmp,
                    poolId: String(req.body.balancePoolId).trim(),
                    memberIds: [createdEmp._id]
                });
            } catch (error) {
                poolAttachError = error.message || 'تعذر ربط المنفّذ بمجموعة الرصيد.';
            }
        }

        return res.json({
            success: true,
            username: finalUsername,
            employeeId: String(createdEmp._id),
            poolAttachError
        });
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

exports.postExternalEmployeeTransaction = async (req, res) => {
    try {
        const result = await fundExternalExecutor({
            manager: req.managerEmp,
            employeeId: req.params.id,
            type: req.body?.type,
            amount: req.body?.amount,
            note: req.body?.note
        });
        return res.json({
            success: true,
            customId: result.customId,
            companyBalance: result.companyPrivateBalance,
            companyPrivateBalance: result.companyPrivateBalance,
            companyTotalBalance: result.companyTotalBalance,
            employeeBalance: result.employeeBalance,
            workingBalance: result.workingBalance,
            membership: result.membership,
            pool: result.pool,
            recipientOnly: true,
            recipientId: result.recipientId
        });
    } catch (e) {
        return poolErrorResponse(res, e);
    }
};

exports.getBalancePools = async (req, res) => {
    try {
        const workspace = await listExternalBalanceWorkspace({ manager: req.managerEmp });
        return res.json({ success: true, ...workspace });
    } catch (e) {
        return poolErrorResponse(res, e);
    }
};

exports.postBalancePoolCreate = async (req, res) => {
    try {
        const pool = await createPool({
            manager: req.managerEmp,
            name: req.body?.name,
            memberIds: req.body?.memberIds || req.body?.members
        });
        const workspace = await listExternalBalanceWorkspace({ manager: req.managerEmp });
        return res.status(201).json({ success: true, pool, ...workspace });
    } catch (e) {
        return poolErrorResponse(res, e);
    }
};

exports.postBalancePoolRename = async (req, res) => {
    try {
        const pool = await renamePool({
            manager: req.managerEmp,
            poolId: req.params.id,
            name: req.body?.name
        });
        return res.json({ success: true, pool });
    } catch (e) {
        return poolErrorResponse(res, e);
    }
};

exports.postBalancePoolAttach = async (req, res) => {
    try {
        const workspace = await attachMembers({
            manager: req.managerEmp,
            poolId: req.params.id,
            memberIds: req.body?.memberIds || req.body?.members || [req.body?.employeeId]
        });
        return res.json({ success: true, ...workspace });
    } catch (e) {
        return poolErrorResponse(res, e);
    }
};

exports.postBalancePoolDetach = async (req, res) => {
    try {
        const workspace = await detachMember({
            manager: req.managerEmp,
            poolId: req.params.id,
            employeeId: req.params.employeeId || req.body?.employeeId
        });
        return res.json({ success: true, ...workspace });
    } catch (e) {
        return poolErrorResponse(res, e);
    }
};

exports.postBalancePoolArchive = async (req, res) => {
    try {
        const workspace = await archivePool({
            manager: req.managerEmp,
            poolId: req.params.id
        });
        return res.json({ success: true, archived: true, ...workspace });
    } catch (e) {
        return poolErrorResponse(res, e);
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

exports.postExecutionPolicy = async (req, res) => {
    try {
        const policy = await mobileWebParityService.updateCompanyExecutionPolicy({
            executorId: req.managerEmp._id,
            body: req.body
        });
        clearExecutorAuthCache();
        return res.json({ success: true, executionPolicy: policy });
    } catch (error) {
        const status = error.message === 'NOT_FOUND' ? 404 : (error.message === 'FORBIDDEN' ? 403 : 400);
        return res.status(status).json({ success: false, error: 'تعذر حفظ صلاحيات التنفيذ.' });
    }
};

exports.postEmployeeExecutionPolicy = async (req, res) => {
    return res.status(403).json({
        success: false,
        code: 'ADMIN_ONLY',
        error: 'تعديل صلاحيات المنفذ متاح للإدارة المركزية فقط.'
    });
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
        const lite = req.query?.lite === '1' || req.query?.lite === 'true';
        const payload = await loadPortalLiveTasks({
            emp,
            includeCompletedList: !lite
        });
        return res.json(payload);
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
