'use strict';

const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { syncBotBalance } = require('../utils/helpers');
const { withOptionalMongoTransaction } = require('./adminFinancialMutationService');
const { queryWithSession } = require('../utils/executorLedgerGuard');

const IN_FLIGHT_STATUSES = Object.freeze([
    'pending',
    'processing',
    'accepted',
    'deposit_pending'
]);

class ExecutorArchiveError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ExecutorArchiveError';
        this.code = code;
        this.details = details;
    }
}

const executorTransactionFilter = (executorId) => ({
    $or: [
        { executorGroupId: executorId },
        { managerGroupId: executorId }
    ]
});

const archiveExecutorAccount = async ({ executorId, archivedBy, reason }) => withOptionalMongoTransaction(async (session) => {
    const group = await queryWithSession(ExecutorGroup.findById(executorId), session);
    if (!group) {
        throw new ExecutorArchiveError('EXECUTOR_NOT_FOUND', 'لم يتم العثور على حساب المنفذ.');
    }

    if (group.status === 'archived') {
        await suspendArchivedEmployeesAndRemoveRoutes({ group, session });
        return { group, alreadyArchived: true };
    }

    if (group.status === 'active') {
        throw new ExecutorArchiveError(
            'EXECUTOR_ACTIVE',
            'يجب إيقاف المنفذ أولاً قبل نقله إلى الأرشيف.'
        );
    }

    const linkedExecutorCount = await queryWithSession(ExecutorGroup.countDocuments({
        _id: { $ne: group._id },
        status: { $ne: 'archived' },
        $or: [
            { parentGroupId: group._id },
            { parentBotId: group._id }
        ]
    }), session);
    if (linkedExecutorCount > 0) {
        throw new ExecutorArchiveError(
            'LINKED_EXECUTORS',
            'لا يمكن أرشفة هذا الحساب قبل فك ارتباط المنفذين التابعين له.',
            { linkedExecutorCount }
        );
    }

    const transactionFilter = executorTransactionFilter(group._id);
    const inFlightCount = await queryWithSession(Transaction.countDocuments({
        ...transactionFilter,
        status: { $in: IN_FLIGHT_STATUSES }
    }), session);
    if (inFlightCount > 0) {
        throw new ExecutorArchiveError(
            'IN_FLIGHT_TRANSACTIONS',
            `لا يمكن أرشفة المنفذ لوجود ${inFlightCount} عملية غير مكتملة مرتبطة به.`,
            { inFlightCount }
        );
    }

    const archiveBalance = await syncBotBalance(group._id, { session });
    // MongoDB sessions do not support parallel operations in a transaction.
    const archiveTransactionCount = await queryWithSession(Transaction.countDocuments(transactionFilter), session);
    const archiveEmployeeCount = await queryWithSession(Employee.countDocuments({ groupId: group._id }), session);
    const archivedAt = new Date();
    const cleanReason = String(reason || '').trim().slice(0, 500) || 'أرشفة حساب منفذ غير نشط';
    const cleanArchivedBy = String(archivedBy || '').trim() || 'الإدارة';

    const archivedGroup = await ExecutorGroup.findOneAndUpdate(
        { _id: group._id, status: { $ne: 'active' } },
        {
            $set: {
                status: 'archived',
                archivedAt,
                archivedBy: cleanArchivedBy,
                archiveReason: cleanReason,
                archiveBalance,
                archiveTransactionCount,
                archiveEmployeeCount
            }
        },
        { returnDocument: 'after', ...(session ? { session } : {}) }
    );
    if (!archivedGroup) {
        throw new ExecutorArchiveError(
            'EXECUTOR_ACTIVE',
            'تم تفعيل المنفذ أثناء تنفيذ الطلب، لذلك لم تتم أرشفته.'
        );
    }

    await suspendArchivedEmployeesAndRemoveRoutes({ group: archivedGroup, session });

    return {
        group: archivedGroup,
        alreadyArchived: false,
        archiveBalance,
        archiveTransactionCount,
        archiveEmployeeCount
    };
});

const suspendArchivedEmployeesAndRemoveRoutes = async ({ group, session }) => {
    const options = session ? { session } : {};
    await Employee.updateMany(
        { groupId: group._id },
        {
            $set: {
                status: 'suspended',
                archivedAt: group.archivedAt,
                archivedBy: group.archivedBy
            },
            $unset: {
                refreshToken: 1,
                otpCode: 1,
                otpExpires: 1
            }
        },
        options
    );

    await Settings.updateMany(
        {},
        { $pull: { autoRouteRules: { executorGroupId: group._id } } },
        options
    );
    await Settings.updateMany(
        { autoRouteBotId: group._id },
        { $set: { autoRouteBotId: null } },
        options
    );
};

module.exports = {
    IN_FLIGHT_STATUSES,
    ExecutorArchiveError,
    archiveExecutorAccount,
    executorTransactionFilter
};
