const ExecutorGroup = require('../../../models/ExecutorGroup');
const {
    executorRequestTenantScope,
    listRouteCandidates,
    routeExecutorTask,
    routingErrorMessage,
} = require('../../../services/executorTaskRoutingService');
const mobileWebParityService = require('../../../services/mobileWebParityService');
const { clearExecutorAuthCache } = require('../../../services/executorAuthCache');

exports.postTaskRoutingMode = async (req, res) => {
    try {
        const group = await ExecutorGroup.findByIdAndUpdate(
            req.managerEmp.groupId,
            { $set: { manualTaskRoutingEnabled: Boolean(req.body?.enabled) } },
            { returnDocument: 'after' }
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
            body: req.body,
        });
        clearExecutorAuthCache();
        return res.json({ success: true, executionPolicy: policy });
    } catch (error) {
        const status = error.message === 'NOT_FOUND' ? 404 : error.message === 'FORBIDDEN' ? 403 : 400;
        return res.status(status).json({ success: false, error: 'تعذر حفظ صلاحيات التنفيذ.' });
    }
};

exports.postEmployeeExecutionPolicy = async (req, res) => {
    return res.status(403).json({
        success: false,
        code: 'ADMIN_ONLY',
        error: 'تعديل صلاحيات المنفذ متاح للإدارة المركزية فقط.',
    });
};

exports.getRouteCandidates = async (req, res) => {
    try {
        const employees = await listRouteCandidates({
            groupId: req.managerEmp.groupId,
            tenantId: executorRequestTenantScope(req),
        });
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
            employeeId: req.body?.employeeId,
            tenantId: executorRequestTenantScope(req),
        });
        if (!result.ok) {
            const status =
                result.code === 'ACTIVE_TASK_EXISTS' || result.code === 'TASK_UNAVAILABLE' ? 409 : 400;
            return res
                .status(status)
                .json({ success: false, code: result.code, error: routingErrorMessage(result.code) });
        }
        return res.json({
            success: true,
            employee: { id: String(result.employee._id), name: result.employee.name },
        });
    } catch (_) {
        return res.status(500).json({ success: false, error: 'تعذر توجيه العملية.' });
    }
};
