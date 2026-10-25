'use strict';

const { invalidateExecutorAuth, loadExecutorEmployee } = require('../services/executorAuthCache');
const { logExecutorFailure } = require('../services/executorTransactionError');

const isJsonRequest = (req) =>
    req.path.startsWith('/api/') ||
    ['/reports/filter', '/reports/employees'].includes(req.path) ||
    String(req.get('Accept') || '').includes('application/json');

const rejectExecutorSession = (req, res) => {
    if (isJsonRequest(req)) {
        return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
    }
    return res.redirect('/login');
};

const clearExecutorSession = (session) => {
    invalidateExecutorAuth(session.executorId);
    for (const field of ['isExecutorLoggedIn', 'executorId', 'executorGroupId', 'executorSessionVersion']) {
        delete session[field];
    }
};

const requireExecutorAuth = async (req, res, next) => {
    if (!req.session?.isExecutorLoggedIn || !req.session.executorId) return rejectExecutorSession(req, res);
    if (req.session.mfaEnrollmentRequired) {
        if (isJsonRequest(req)) {
            return res.status(403).json({
                success: false,
                code: 'MFA_ENROLLMENT_REQUIRED',
                error: 'أكمل إعداد التحقق الإضافي قبل متابعة العمل.',
            });
        }
        return res.redirect('/security/mfa-enroll');
    }
    try {
        const employee = await loadExecutorEmployee(req.session.executorId, {
            fresh: true,
            lean: ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
        });
        if (
            !employee ||
            employee.status !== 'active' ||
            !employee.groupId ||
            employee.groupId.status !== 'active' ||
            Number(employee.sessionVersion || 0) !== Number(req.session.executorSessionVersion || 0)
        ) {
            clearExecutorSession(req.session);
            return rejectExecutorSession(req, res);
        }
        req.executorEmployee = employee;
        return next();
    } catch (error) {
        logExecutorFailure('session-check', error);
        return rejectExecutorSession(req, res);
    }
};

const requireExecutorManager = (req, res, next) =>
    requireExecutorAuth(req, res, () => {
        const employee = req.executorEmployee;
        if (employee.role !== 'manager') {
            if (isJsonRequest(req))
                return res.status(403).json({ success: false, error: 'هذه الصفحة متاحة لمدير المنفذ فقط.' });
            return res.redirect('/executor-portal/reports');
        }
        req.managerEmp = employee;
        return next();
    });

const requireExecutorTaskAccess = (req, res, next) => {
    if (!['manager', 'operator', 'external'].includes(req.executorEmployee?.role)) {
        return res.status(403).json({ success: false, error: 'هذا الحساب لا يملك صلاحية تنفيذ العمليات.' });
    }
    return next();
};

const requireExecutorDepositAccess = (req, res, next) => {
    if (!['manager', 'accountant', 'external'].includes(req.executorEmployee?.role)) {
        return res.status(403).json({ success: false, error: 'هذه الصفحة غير متاحة لهذا الحساب.' });
    }
    return next();
};

module.exports = {
    requireExecutorAuth,
    requireExecutorManager,
    requireExecutorTaskAccess,
    requireExecutorDepositAccess,
};
