const { logExecutorFailure } = require('../../../services/executorTransactionError');
const Employee = require('../../../models/Employee');
const {
    QuickExecuteError,
    buildQuickExecuteDial,
    getQuickExecuteState,
    saveQuickExecutePreferences,
} = require('../../../services/executorQuickExecuteService');

const sendQuickExecuteError = (res, error) => {
    const expected = error instanceof QuickExecuteError;
    const status = expected ? Number(error.status) || 400 : 500;
    if (!expected) logExecutorFailure('quick-execute', error);
    return res.status(status).json({
        success: false,
        code: expected ? error.code : 'QUICK_EXECUTE_FAILED',
        error: expected ? error.message : 'تعذر تنفيذ الطلب السريع.',
    });
};

const publicDialPayload = (dial) => ({
    network: dial.network,
    networkLabel: dial.networkLabel,
    pinIncluded: Boolean(dial.pinIncluded),
    pinSet: Boolean(dial.pinSet),
    securityNote: dial.securityNote || '',
    ussd: dial.ussd,
    telUri: dial.telUri,
    acceptedNow: Boolean(dial.acceptedNow),
});

exports.getQuickExecute = async (req, res) => {
    try {
        const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const quickExecute = await getQuickExecuteState({ executorId: emp._id });
        return res.json({ success: true, quickExecute });
    } catch (error) {
        return sendQuickExecuteError(res, error);
    }
};

exports.putQuickExecute = async (req, res) => {
    try {
        const emp = req.executorEmployee || (await Employee.findById(req.session.executorId));
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const quickExecute = await saveQuickExecutePreferences({
            executorId: emp._id,
            network: req.body?.network,
            pin: req.body?.pin,
            clearPin: req.body?.clearPin === true,
        });
        return res.json({ success: true, quickExecute });
    } catch (error) {
        return sendQuickExecuteError(res, error);
    }
};

exports.postQuickExecuteDial = async (req, res) => {
    try {
        const emp =
            req.executorEmployee || (await Employee.findById(req.session.executorId).populate('groupId'));
        if (!emp) return res.status(401).json({ success: false, error: 'انتهت جلسة الدخول.' });
        const dial = await buildQuickExecuteDial({
            executorId: emp._id,
            executor: emp,
            taskId: req.params.id,
            pin: req.body?.pin,
            tenantId: req.tenant ? req.tenant._id : null,
        });
        return res.json({ success: true, ...publicDialPayload(dial) });
    } catch (error) {
        return sendQuickExecuteError(res, error);
    }
};
