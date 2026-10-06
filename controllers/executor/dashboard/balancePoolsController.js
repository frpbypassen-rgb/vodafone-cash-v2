const { logExecutorFailure } = require('../../../services/executorTransactionError');
const {
    ExecutorBalancePoolError,
    archivePool,
    attachMembers,
    createPool,
    detachMember,
    fundExternalExecutor,
    listExternalBalanceWorkspace,
    renamePool,
} = require('../../../services/executorBalancePoolService');

const poolErrorResponse = (res, error) => {
    if (error instanceof ExecutorBalancePoolError) {
        return res
            .status(error.status || 400)
            .json({ success: false, error: error.message, code: error.code });
    }
    logExecutorFailure('balance-pool', error);
    return res.status(500).json({ success: false, error: 'تعذر إكمال العملية.' });
};

exports.postExternalEmployeeTransaction = async (req, res) => {
    try {
        const result = await fundExternalExecutor({
            manager: req.managerEmp,
            employeeId: req.params.id,
            type: req.body?.type,
            amount: req.body?.amount,
            note: req.body?.note,
            requestId: req.body?.requestId,
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
            recipientId: result.recipientId,
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
            memberIds: req.body?.memberIds || req.body?.members,
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
            name: req.body?.name,
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
            memberIds: req.body?.memberIds || req.body?.members || [req.body?.employeeId],
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
            employeeId: req.params.employeeId || req.body?.employeeId,
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
            poolId: req.params.id,
        });
        return res.json({ success: true, archived: true, ...workspace });
    } catch (e) {
        return poolErrorResponse(res, e);
    }
};
