const { logAction } = require('../../../services/auditService');
const bcrypt = require('bcryptjs');
const Employee = require('../../../models/Employee');
const { ExecutorAccountError, normalizeExecutorPhone } = require('../../../services/executorAccountService');
const mobileWebParityService = require('../../../services/mobileWebParityService');
const { invalidateExecutorAuth } = require('../../../services/executorAuthCache');
const { getExecutorServiceLabel } = require('../../../utils/executorServiceCatalog');

exports.getSettings = async (req, res) => {
    try {
        const emp =
            req.executorEmployee || (await Employee.findById(req.session.executorId).populate('groupId'));
        const overview = await mobileWebParityService.getExecutorOverview({
            executorId: emp._id,
            tenantId: req.tenant ? req.tenant._id : null,
        });
        const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
        delete req.session.showMfaEnableNotice;
        const companyBalances = overview.company
            ? {
                  privateBalance: Number(overview.company.privateBalance ?? overview.company.balance ?? 0),
                  totalBalance: Number(overview.company.totalBalance ?? overview.company.balance ?? 0),
                  allocatedBalance: Number(overview.company.allocatedBalance || 0),
                  multiService: Boolean(overview.company.multiService),
                  byService: Array.isArray(overview.company.serviceBalances)
                      ? overview.company.serviceBalances
                      : [],
              }
            : null;
        return res.render('executor/settings', {
            emp,
            overview,
            showMfaNotice,
            companyBalances,
            serviceLabel: getExecutorServiceLabel(overview.company?.serviceKey || emp.groupId?.serviceKey),
        });
    } catch (_) {
        return res.redirect('/executor-portal/dashboard');
    }
};

exports.patchSettingsProfile = async (req, res) => {
    try {
        const name = String(req.body?.name || '')
            .trim()
            .replace(/\s+/g, ' ');
        if (name.length < 3 || name.length > 100) {
            return res.status(422).json({ success: false, error: 'الاسم يجب أن يكون بين 3 و100 حرف.' });
        }
        const phone = normalizeExecutorPhone(req.body?.phone);
        const employee = await Employee.findById(req.session.executorId);
        if (!employee || employee.status !== 'active')
            return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        employee.name = name;
        employee.phone = phone;
        await employee.save();
        invalidateExecutorAuth(employee._id);
        await logAction({
            action: 'USER_UPDATED',
            performedById: employee._id,
            performedByModel: 'Employee',
            performedByName: employee.name,
            targetId: employee._id,
            targetModel: 'Employee',
            result: 'نجاح',
            metadata: { scope: 'self_profile' },
        });
        return res.json({ success: true, name: employee.name, phone: employee.phone });
    } catch (error) {
        if (error instanceof ExecutorAccountError)
            return res.status(422).json({ success: false, error: error.message });
        return res.status(500).json({ success: false, error: 'تعذر حفظ بيانات الحساب.' });
    }
};

exports.postSettingsPassword = async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const confirmPassword = String(req.body?.confirmPassword || '');
    if (
        !currentPassword ||
        newPassword.length < 8 ||
        newPassword.length > 128 ||
        newPassword !== confirmPassword ||
        newPassword === currentPassword
    ) {
        return res
            .status(422)
            .json({ success: false, error: 'تحقق من كلمة المرور الجديدة وتأكيدها (8 أحرف على الأقل).' });
    }
    try {
        const employee = await Employee.findById(req.session.executorId);
        if (!employee || employee.status !== 'active')
            return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        if (!(await bcrypt.compare(currentPassword, employee.webPassword || ''))) {
            return res.status(422).json({ success: false, error: 'كلمة المرور الحالية غير صحيحة.' });
        }
        employee.webPassword = await bcrypt.hash(newPassword, 12);
        employee.sessionVersion = Number(employee.sessionVersion || 0) + 1;
        await employee.save();
        req.session.executorSessionVersion = employee.sessionVersion;
        invalidateExecutorAuth(employee._id);
        await logAction({
            action: 'USER_PASSWORD_CHANGED',
            performedById: employee._id,
            performedByModel: 'Employee',
            performedByName: employee.name,
            targetId: employee._id,
            targetModel: 'Employee',
            result: 'نجاح',
            metadata: { scope: 'self_password' },
        });
        return res.json({ success: true });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر تغيير كلمة المرور.' });
    }
};
