const { logAction } = require('../../../services/auditService');
const { logExecutorFailure } = require('../../../services/executorTransactionError');
const { escapeRegex } = require('../../../utils/helpers');
const {
    EXECUTOR_PASSWORD_MESSAGE,
    isValidNewExecutorPassword,
} = require('../../../utils/executorPasswordPolicy');
const Employee = require('../../../models/Employee');
const {
    ExecutorAccountError,
    normalizeExecutorPhone,
    normalizeExecutorUsername,
} = require('../../../services/executorAccountService');
const mobileWebParityService = require('../../../services/mobileWebParityService');
const mobileWebParityMapper = require('../../../mappers/mobileWebParityMapper');
const { invalidateExecutorAuth } = require('../../../services/executorAuthCache');
const {
    ExecutorBalancePoolError,
    attachMembers,
    listExternalBalanceWorkspace,
    snapshotCompanyBalances,
} = require('../../../services/executorBalancePoolService');
const { belongsToGroup } = require('./access');

exports.getEmployees = async (req, res) => {
    const emp = req.managerEmp || (await Employee.findById(req.session.executorId).populate('groupId'));
    const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
    delete req.session.showMfaEnableNotice;
    const companyBalances = await snapshotCompanyBalances(emp.groupId).catch(() => null);
    res.render('executor/employees', { emp, showMfaNotice, companyBalances });
};

exports.getEmployeesList = async (req, res) => {
    try {
        const workspace = await mobileWebParityService.getEmployeesWorkspace({
            executorId: req.managerEmp._id,
            tenantId: req.tenant ? req.tenant._id : null,
        });
        const pools = await listExternalBalanceWorkspace({ manager: req.managerEmp }).catch(() => null);
        res.json({
            success: true,
            employees: workspace.employees.map((employee) => mobileWebParityMapper.toEmployeeDto(employee)),
            summary: {
                ...workspace.summary,
                ...(pools?.balances || {}),
            },
            pools: pools?.pools || [],
            soloExternals: pools?.solos || [],
            companyExecutionPolicy: workspace.companyExecutionPolicy || null,
        });
    } catch (error) {
        logExecutorFailure('employees-list', error);
        res.status(500).json({ success: false, error: 'تعذر تحميل بيانات الموظفين.' });
    }
};

exports.postEmployeesUpdate = async (req, res) => {
    try {
        const updated = await mobileWebParityService.updateEmployeeProfile({
            executorId: req.managerEmp._id,
            targetId: req.params.id,
            name: req.body?.name,
            phone: req.body?.phone,
        });
        return res.json({
            success: true,
            employee: { id: String(updated._id), name: updated.name, phone: updated.phone },
        });
    } catch (error) {
        const status = error.message === 'NOT_FOUND' ? 404 : error.message === 'FORBIDDEN' ? 403 : 400;
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
        if (!isValidNewExecutorPassword(webPassword)) {
            return res.status(400).json({ success: false, error: EXECUTOR_PASSWORD_MESSAGE });
        }

        const finalUsername = normalizeExecutorUsername(webUsername);
        const finalPhone = normalizeExecutorPhone(phone);
        const existing = await Employee.exists({
            webUsername: new RegExp(`^${escapeRegex(finalUsername)}$`, 'i'),
        });
        if (existing) return res.status(409).json({ success: false, error: 'اسم الدخول مستخدم بالفعل.' });
        const createdEmp = await Employee.create({
            name: cleanName,
            phone: finalPhone,
            role,
            status: 'active',
            groupId: req.managerEmp.groupId,
            tenantId: req.managerEmp.tenantId || req.tenant?._id || undefined,
            webUsername: finalUsername,
            webPassword,
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
                name: name,
            },
        });

        let poolAttachError = null;
        if (role === 'external' && String(req.body?.balancePoolId || '').trim()) {
            try {
                await attachMembers({
                    manager: req.managerEmp,
                    poolId: String(req.body.balancePoolId).trim(),
                    memberIds: [createdEmp._id],
                });
            } catch (error) {
                if (!(error instanceof ExecutorBalancePoolError))
                    logExecutorFailure('employee-pool-attach', error);
                poolAttachError =
                    error instanceof ExecutorBalancePoolError
                        ? error.message
                        : 'تعذر ربط المنفّذ بمجموعة الرصيد.';
            }
        }

        return res.json({
            success: true,
            username: finalUsername,
            employeeId: String(createdEmp._id),
            poolAttachError,
        });
    } catch (e) {
        logExecutorFailure('employee-create', e);
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
    } catch (error) {
        logExecutorFailure('employee-toggle', error);
        res.json({ success: false, error: 'تعذر تغيير حالة الموظف.' });
    }
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
    } catch (error) {
        logExecutorFailure('employee-report-access', error);
        res.json({ success: false, error: 'تعذر تغيير صلاحية التقارير.' });
    }
};

exports.postEmployeesResetPassword = async (req, res) => {
    try {
        const newPassword = String(req.body.newPassword || '');
        if (!isValidNewExecutorPassword(newPassword))
            return res.status(400).json({ success: false, error: EXECUTOR_PASSWORD_MESSAGE });
        const emp = await Employee.findById(req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'الموظف غير موجود.' });
        if (!belongsToGroup(emp, req.managerEmp.groupId)) {
            return res.status(403).json({ success: false, error: 'لا يمكن تعديل موظف تابع لمنفذ آخر.' });
        }
        if (emp.role === 'manager') return res.json({ success: false, error: 'Not allowed' });
        emp.webPassword = newPassword;
        emp.sessionVersion = Number(emp.sessionVersion || 0) + 1;
        await emp.save();
        invalidateExecutorAuth(emp._id);
        res.json({ success: true });
    } catch (error) {
        logExecutorFailure('employee-password-reset', error);
        res.json({ success: false, error: 'تعذر تغيير كلمة مرور الموظف.' });
    }
};

exports.postEmployeesDelete = async (req, res) => {
    try {
        await mobileWebParityService.deleteEmployee({
            executorId: req.managerEmp._id,
            targetId: req.params.id,
        });
        return res.json({ success: true, archived: true });
    } catch (error) {
        const status = error.message === 'NOT_FOUND' ? 404 : error.message === 'FORBIDDEN' ? 403 : 400;
        return res.status(status).json({ success: false, error: 'تعذر أرشفة حساب الموظف.' });
    }
};
