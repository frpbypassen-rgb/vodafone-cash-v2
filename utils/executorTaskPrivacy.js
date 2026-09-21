'use strict';

const stringId = (value) => String(value?._id || value || '');

const ACCEPTABLE_TASK_STATUSES = Object.freeze(['processing', 'pending']);

const ROUTING_STATES = Object.freeze({
    UNASSIGNED: 'unassigned',
    PENDING_WITH_ASSIGNEE: 'pending_with_assignee',
    IN_PROGRESS: 'in_progress'
});

const ROUTING_STATE_LABELS = Object.freeze({
    [ROUTING_STATES.UNASSIGNED]: 'متاح',
    [ROUTING_STATES.PENDING_WITH_ASSIGNEE]: 'معلّقة عنده',
    [ROUTING_STATES.IN_PROGRESS]: 'بدأ التنفيذ'
});

const taskRecipientValue = (transaction = {}) => String(
    transaction.serviceDetails?.recipientPhone
    || transaction.vodafoneNumber
    || transaction.accountNumber
    || ''
).trim();

const taskRecipientPrefix = (value) => {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) return '';
    const digits = cleanValue.replace(/\D/g, '');
    return (digits || cleanValue).slice(0, 3);
};

const isTaskOwnedByExecutor = (transaction = {}, executorId = null) => (
    transaction.status === 'accepted'
    && Boolean(executorId)
    && stringId(transaction.operatorId) === stringId(executorId)
);

const isAcceptedOwnedByExecutor = (transaction = {}, executorId = null) => {
    if (transaction.status !== 'accepted' || !executorId) return false;
    const currentId = stringId(executorId);
    const operatorId = stringId(transaction.operatorId);
    const assignedExecutorId = stringId(transaction.assignedExecutorId);
    return (
        (!operatorId || operatorId === currentId)
        && (!assignedExecutorId || assignedExecutorId === currentId)
        && (operatorId === currentId || assignedExecutorId === currentId)
    );
};

const isCashWalletTask = (transaction = {}) => String(transaction.transferType || '').trim() === 'vodafone';

const canQuickExecuteTask = (transaction = {}, executorId = null) => (
    isCashWalletTask(transaction) && isAcceptedOwnedByExecutor(transaction, executorId)
);

const canClaimThenQuickExecuteTask = (transaction = {}, executorId = null) => (
    isCashWalletTask(transaction)
    && Boolean(buildTaskRoutingVisibility(transaction, executorId).isAssignedToCurrentExecutor)
);

const buildExecutorTaskRecipient = (transaction = {}, executorId = null) => {
    const fullRecipient = taskRecipientValue(transaction);
    const recipientPrefix = taskRecipientPrefix(fullRecipient);
    const recipientRevealed = isTaskOwnedByExecutor(transaction, executorId);

    return {
        recipientNumber: recipientRevealed ? (fullRecipient || null) : (recipientPrefix || null),
        recipientPrefix: recipientPrefix || null,
        recipientRevealed
    };
};

const routingStateForTask = (transaction = {}) => {
    if (transaction.status === 'accepted') return ROUTING_STATES.IN_PROGRESS;
    const assignedExecutorId = stringId(transaction.assignedExecutorId);
    if (assignedExecutorId && ACCEPTABLE_TASK_STATUSES.includes(transaction.status)) {
        return ROUTING_STATES.PENDING_WITH_ASSIGNEE;
    }
    return ROUTING_STATES.UNASSIGNED;
};

const buildTaskRoutingVisibility = (transaction = {}, executorId = null) => {
    const routingState = routingStateForTask(transaction);
    const assignedExecutorId = transaction.assignedExecutorId ? stringId(transaction.assignedExecutorId) : null;
    const currentId = executorId ? stringId(executorId) : '';
    return {
        routingState,
        routingStateLabel: ROUTING_STATE_LABELS[routingState],
        assignedExecutorId,
        assignedExecutorName: transaction.assignedExecutorName || null,
        assignedExecutorAt: transaction.assignedExecutorAt || null,
        isAssignedToCurrentExecutor: Boolean(
            currentId
            && assignedExecutorId
            && assignedExecutorId === currentId
            && routingState === ROUTING_STATES.PENDING_WITH_ASSIGNEE
        )
    };
};

const LIVE_TASK_NOTES_MAX = 400;
const STUCK_ASSIGNEE_SLA_SECONDS = 90;

const stuckAssigneeSlaHint = ({
    routingState,
    assignedExecutorAt,
    now = Date.now(),
    thresholdSeconds = STUCK_ASSIGNEE_SLA_SECONDS
} = {}) => {
    if (routingState !== ROUTING_STATES.PENDING_WITH_ASSIGNEE || !assignedExecutorAt) {
        return null;
    }
    const assignedAtMs = new Date(assignedExecutorAt).getTime();
    if (!Number.isFinite(assignedAtMs)) return null;
    const waitedSeconds = Math.max(0, Math.floor((now - assignedAtMs) / 1000));
    if (waitedSeconds < thresholdSeconds) return null;
    const minutes = Math.max(1, Math.round(waitedSeconds / 60));
    return {
        waitedSeconds,
        labelAr: `معلّقة عنده منذ ${minutes} د — قد تحتاج إعادة توجيه`
    };
};

const portalLiveTaskNotes = (notes) => {
    let text = String(notes || '');
    const apiLogAt = text.search(/--- سجل الـ API/);
    if (apiLogAt >= 0) text = text.slice(0, apiLogAt);
    text = text.trim();
    if (text.length > LIVE_TASK_NOTES_MAX) text = `${text.slice(0, LIVE_TASK_NOTES_MAX)}…`;
    return text;
};

const toExecutorPortalTaskDto = (transaction = {}, executorId = null) => {
    const recipient = buildExecutorTaskRecipient(transaction, executorId);
    const routing = buildTaskRoutingVisibility(transaction, executorId);
    const isCashWallet = transaction.transferType === 'vodafone';

    return {
        _id: stringId(transaction._id) || null,
        customId: transaction.customId || null,
        transferType: transaction.transferType || null,
        amount: Number(transaction.amount || 0),
        vodafoneNumber: isCashWallet ? recipient.recipientNumber : null,
        accountNumber: isCashWallet ? null : recipient.recipientNumber,
        recipientNumber: recipient.recipientNumber,
        recipientPrefix: recipient.recipientPrefix,
        recipientRevealed: recipient.recipientRevealed,
        accountName: transaction.accountName || null,
        notes: portalLiveTaskNotes(transaction.notes),
        status: transaction.status || 'unknown',
        operatorId: transaction.operatorId ? stringId(transaction.operatorId) : null,
        executorName: transaction.executorName || null,
        assignedExecutorId: routing.assignedExecutorId,
        assignedExecutorName: routing.assignedExecutorName,
        assignedExecutorAt: routing.assignedExecutorAt,
        routingState: routing.routingState,
        routingStateLabel: routing.routingStateLabel,
        isAssignedToCurrentExecutor: routing.isAssignedToCurrentExecutor,
        isOwnedByCurrentExecutor: isAcceptedOwnedByExecutor(transaction, executorId),
        canQuickExecute: canQuickExecuteTask(transaction, executorId),
        canClaimThenQuickExecute: canClaimThenQuickExecuteTask(transaction, executorId),
        executorReceivedAt: transaction.executorReceivedAt || null,
        createdAt: transaction.createdAt || null,
        emergencyAlert: transaction.emergencyAlert || null
    };
};

module.exports = {
    LIVE_TASK_NOTES_MAX,
    ROUTING_STATES,
    ROUTING_STATE_LABELS,
    STUCK_ASSIGNEE_SLA_SECONDS,
    buildExecutorTaskRecipient,
    buildTaskRoutingVisibility,
    canClaimThenQuickExecuteTask,
    canQuickExecuteTask,
    isAcceptedOwnedByExecutor,
    isCashWalletTask,
    isTaskOwnedByExecutor,
    portalLiveTaskNotes,
    routingStateForTask,
    stuckAssigneeSlaHint,
    taskRecipientPrefix,
    taskRecipientValue,
    toExecutorPortalTaskDto
};
