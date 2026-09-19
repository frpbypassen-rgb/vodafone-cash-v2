'use strict';

// Admin central ledger and operations lists keep active work at the top:
// pending → in progress → successful/completed → failed/cancelled.
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

const transactionStatusQueueOrder = (status) => {
    const key = String(status || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(TRANSACTION_STATUS_QUEUE_ORDER, key)
        ? TRANSACTION_STATUS_QUEUE_ORDER[key]
        : TRANSACTION_STATUS_QUEUE_DEFAULT_ORDER;
};

const createdAtMs = (value) => {
    const time = new Date(value || 0).getTime();
    return Number.isFinite(time) ? time : 0;
};

const compareTransactionsByStatusQueue = (left, right) => {
    const orderDiff = transactionStatusQueueOrder(left?.status) - transactionStatusQueueOrder(right?.status);
    if (orderDiff !== 0) return orderDiff;

    const timeDiff = createdAtMs(right?.createdAt) - createdAtMs(left?.createdAt);
    if (timeDiff !== 0) return timeDiff;

    return String(right?._id || '').localeCompare(String(left?._id || ''));
};

const sortTransactionsByStatusQueue = (transactions) => [...(transactions || [])].sort(compareTransactionsByStatusQueue);

const transactionStatusQueueAddFieldsStage = () => ({
    $addFields: {
        operationQueueOrder: {
            $switch: {
                branches: TRANSACTION_STATUS_QUEUE_GROUPS.map((group) => ({
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

const transactionStatusQueuePipelineStages = ({ skip = 0, limit } = {}) => {
    const stages = [
        transactionStatusQueueAddFieldsStage(),
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
