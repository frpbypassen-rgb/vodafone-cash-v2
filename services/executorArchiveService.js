'use strict';

const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { syncBotBalance } = require('../utils/helpers');

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

const archiveExecutorAccount = async ({ executorId, archivedBy, reason }) => {
    const group = await ExecutorGroup.findById(executorId);
    if (!group) {
        throw new ExecutorArchiveError('EXECUTOR_NOT_FOUND', 'لم يتم العثور على حساب المنفذ.');
    }

    if (group.status === 'archived') {
        return { group, alreadyArchived: true };
    }

    if (group.status === 'active') {
        throw new ExecutorArchiveError(
            'EXECUTOR_ACTIVE',
            'يجب إيقاف المنفذ أولاً قبل نقله إلى الأرشيف.'
        );
    }

    const linkedExecutorCount = await ExecutorGroup.countDocuments({
        _id: { $ne: group._id },
        status: { $ne: 'archived' },
        $or: [
            { parentGroupId: group._id },
            { parentBotId: group._id }
        ]
    });
    if (linkedExecutorCount > 0) {
        throw new ExecutorArchiveError(
            'LINKED_EXECUTORS',
            'لا يمكن أرشفة هذا الحساب قبل فك ارتباط المنفذين التابعين له.',
            { linkedExecutorCount }
        );
    }

    const transactionFilter = executorTransactionFilter(group._id);
    const inFlightCount = await Transaction.countDocuments({
        ...transactionFilter,
        status: { $in: IN_FLIGHT_STATUSES }
    });
    if (inFlightCount > 0) {
        throw new ExecutorArchiveError(
            'IN_FLIGHT_TRANSACTIONS',
            `لا يمكن أرشفة المنفذ لوجود ${inFlightCount} عملية غير مكتملة مرتبطة به.`,
            { inFlightCount }
        );
    }

    const archiveBalance = await syncBotBalance(group._id);
    const [archiveTransactionCount, archiveEmployeeCount] = await Promise.all([
        Transaction.countDocuments(transactionFilter),
        Employee.countDocuments({ groupId: group._id })
    ]);
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
        { new: true }
    );
    if (!archivedGroup) {
        throw new ExecutorArchiveError(
            'EXECUTOR_ACTIVE',
            'تم تفعيل المنفذ أثناء تنفيذ الطلب، لذلك لم تتم أرشفته.'
        );
    }

    await Employee.updateMany(
        { groupId: group._id },
        {
            $set: {
                status: 'suspended',
                archivedAt,
                archivedBy: cleanArchivedBy
            },
            $unset: {
                refreshToken: 1,
                otpCode: 1,
                otpExpires: 1
            }
        }
    );

    await Settings.updateMany(
        {},
        { $pull: { autoRouteRules: { executorGroupId: group._id } } }
    ).catch(() => {});
    await Settings.updateMany(
        { autoRouteBotId: group._id },
        { $set: { autoRouteBotId: null } }
    ).catch(() => {});

    return {
        group: archivedGroup,
        alreadyArchived: false,
        archiveBalance,
        archiveTransactionCount,
        archiveEmployeeCount
    };
};

module.exports = {
    IN_FLIGHT_STATUSES,
    ExecutorArchiveError,
    archiveExecutorAccount,
    executorTransactionFilter
};
