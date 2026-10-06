const { logExecutorFailure } = require('../../../services/executorTransactionError');
const { emitSupportTicketUpdate } = require('../../../services/supportRealtimeService');
const Employee = require('../../../models/Employee');
const executorDepositRequestService = require('../../../services/executorDepositRequestService');
const {
    snapshotCompanyBalances,
    workingBalanceForEmployee,
} = require('../../../services/executorBalancePoolService');

const depositErrorResponse = (res, error, fallback) => {
    if (error instanceof executorDepositRequestService.ExecutorDepositRequestError) {
        return res.status(error.status).json({ success: false, error: error.message });
    }
    logExecutorFailure('deposit', error);
    return res.status(500).json({ success: false, error: fallback });
};

exports.getDeposits = async (req, res) => {
    const emp =
        req.managerEmp ||
        req.executorEmployee ||
        (await Employee.findById(req.session.executorId).populate('groupId'));
    if (!emp || !['manager', 'accountant', 'external'].includes(emp.role))
        return res.redirect('/executor-portal/reports');
    const showMfaNotice = Boolean(req.session.showMfaEnableNotice);
    delete req.session.showMfaEnableNotice;
    const workingBalance =
        emp.role === 'external'
            ? await workingBalanceForEmployee(emp).catch(() => ({
                  kind: 'solo',
                  balance: Number(emp.balance || 0),
                  pool: null,
              }))
            : null;
    const companyBalances = ['manager', 'accountant'].includes(emp.role)
        ? await snapshotCompanyBalances(emp.groupId).catch(() => null)
        : null;
    return res.render('executor/deposits', {
        emp,
        showMfaNotice,
        depositScope: emp.role === 'external' ? 'external' : 'company',
        workingBalance,
        companyBalances,
    });
};

exports.getDepositRequests = async (req, res) => {
    try {
        const requests = await executorDepositRequestService.listDepositRequests({
            employee: req.managerEmp || req.executorEmployee,
        });
        return res.json({ success: true, requests });
    } catch (error) {
        return depositErrorResponse(res, error, 'تعذر تحميل طلبات الإيداع.');
    }
};

exports.postDepositRequest = async (req, res) => {
    try {
        const request = await executorDepositRequestService.createDepositRequest({
            employee: req.managerEmp || req.executorEmployee,
            amount: req.body?.amount,
            note: req.body?.note,
            receipts: req.body?.receiptsBase64,
        });
        emitSupportTicketUpdate(req, { source: 'executor_deposit_request' });
        return res
            .status(201)
            .json({ success: true, request, message: 'تم إرسال طلب الإيداع للدعم للمراجعة.' });
    } catch (error) {
        return depositErrorResponse(res, error, 'تعذر إرسال طلب الإيداع.');
    }
};

exports.postReviewAdminDeposit = async (req, res) => {
    try {
        const decision = String(req.body?.decision || '');
        if (!['approve', 'reject'].includes(decision))
            return res.status(422).json({ success: false, error: 'قرار المراجعة غير صالح.' });
        const result = await executorDepositRequestService.reviewAdminDepositRequest({
            employee: req.managerEmp || req.executorEmployee,
            requestId: req.params.id,
            approved: decision === 'approve',
            reason: req.body?.reason,
        });
        emitSupportTicketUpdate(req, { source: 'executor_admin_deposit_review' });
        return res.json({
            success: true,
            status: decision === 'approve' ? 'approved' : 'rejected',
            requestId: String(result.transaction._id),
        });
    } catch (error) {
        return depositErrorResponse(res, error, 'تعذر مراجعة طلب الإيداع.');
    }
};
