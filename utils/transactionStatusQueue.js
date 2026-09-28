'use strict';

// The central ledger keeps active work at the top, then successes, then
// failed/cancelled rows. The operations page uses the same active groups,
// but cancelled rows stay in the success timeline and sort by createdAt
// with completed operations instead of a separate cancelled bucket.
// Newest first is the secondary sort inside each group.
const PENDING_STATUSES = Object.freeze(['pending', 'deposit_pending']);
const IN_PROGRESS_STATUSES = Object.freeze(['processing', 'accepted']);
const SUCCESS_STATUSES = Object.freeze(['completed', 'deposit', 'deduction']);
const FAILED_STATUSES = Object.freeze(['rejected', 'cancelled_by_admin', 'cancelled', 'canceled']);

const TRANSACTION_STATUS_QUEUE_GROUPS = Object.freeze([
    { order: 0, statuses: PENDING_STATUSES },
    { order: 1, statuses: IN_PROGRESS_STATUSES },
    { order: 2, statuses: SUCCESS_STATUSES },
    { order: 3, statuses: FAILED_STATUSES }
]);

const TRANSACTION_STATUS_QUEUE_DEFAULT_ORDER = 4;

const TRANSACTION_STATUS_QUEUE_ORDER = Object.freeze(
    Object.fromEntries(
        TRANSACTION_STATUS_QUEUE_GROUPS.flatMap((group) => group.statuses.map((status) => [status, group.order]))
    )
);

const OPERATIONS_TIMELINE_GROUPS = Object.freeze([
    { order: 0, statuses: PENDING_STATUSES },
    { order: 1, statuses: IN_PROGRESS_STATUSES },
    { order: 2, statuses: Object.freeze([...SUCCESS_STATUSES, ...FAILED_STATUSES]) }
]);

const queueGroupsForMode = (mode) => (
    mode === 'operations' ? OPERATIONS_TIMELINE_GROUPS : TRANSACTION_STATUS_QUEUE_GROUPS
);

const transactionStatusQueueOrder = (status, mode = 'ledger') => {
    const key = String(status || '').trim().toLowerCase();
    const match = queueGroupsForMode(mode).find((group) => group.statuses.includes(key));
    return match ? match.order : TRANSACTION_STATUS_QUEUE_DEFAULT_ORDER;
};

const createdAtMs = (value) => {
    const time = new Date(value || 0).getTime();
    return Number.isFinite(time) ? time : 0;
};

const compareTransactionsByStatusQueue = (left, right, mode = 'ledger') => {
    const orderDiff = transactionStatusQueueOrder(left?.status, mode) - transactionStatusQueueOrder(right?.status, mode);
    if (orderDiff !== 0) return orderDiff;

    const timeDiff = createdAtMs(right?.createdAt) - createdAtMs(left?.createdAt);
    if (timeDiff !== 0) return timeDiff;

    return String(right?._id || '').localeCompare(String(left?._id || ''));
};

const sortTransactionsByStatusQueue = (transactions, mode = 'ledger') => (
    [...(transactions || [])].sort((left, right) => compareTransactionsByStatusQueue(left, right, mode))
);

const transactionStatusQueueAddFieldsStage = (mode = 'ledger') => ({
    $addFields: {
        operationQueueOrder: {
            $switch: {
                branches: queueGroupsForMode(mode).map((group) => ({
                    case: { $in: ['$status', [...group.statuses]] },
                    then: group.order
                })),
                default: TRANSACTION_STATUS_QUEUE_DEFAULT_ORDER
            }
        }
    }
});

const transactionStatusQueueSortStage = () => ({
    $sort: { operationQueueOrder: 1, createdAt: -1, _id: -1 }
});

const transactionStatusQueuePipelineStages = ({ skip = 0, limit, mode = 'ledger' } = {}) => {
    const stages = [
        transactionStatusQueueAddFieldsStage(mode),
        transactionStatusQueueSortStage()
    ];
    const skipCount = Number(skip);
    if (Number.isFinite(skipCount) && skipCount > 0) stages.push({ $skip: skipCount });
    const limitCount = Number(limit);
    if (Number.isFinite(limitCount) && limitCount > 0) stages.push({ $limit: limitCount });
    stages.push({ $project: { operationQueueOrder: 0 } });
    return stages;
};

module.exports = {
    PENDING_STATUSES,
    IN_PROGRESS_STATUSES,
    SUCCESS_STATUSES,
    FAILED_STATUSES,
    OPERATIONS_TIMELINE_GROUPS,
    TRANSACTION_STATUS_QUEUE_GROUPS,
    TRANSACTION_STATUS_QUEUE_ORDER,
    TRANSACTION_STATUS_QUEUE_DEFAULT_ORDER,
    transactionStatusQueueOrder,
    compareTransactionsByStatusQueue,
    sortTransactionsByStatusQueue,
    transactionStatusQueueAddFieldsStage,
    transactionStatusQueueSortStage,
    transactionStatusQueuePipelineStages
};
