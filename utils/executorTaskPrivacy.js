'use strict';

const stringId = (value) => String(value?._id || value || '');

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

const toExecutorPortalTaskDto = (transaction = {}, executorId = null) => {
    const recipient = buildExecutorTaskRecipient(transaction, executorId);
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
        notes: transaction.notes || '',
        status: transaction.status || 'unknown',
        operatorId: transaction.operatorId ? stringId(transaction.operatorId) : null,
        executorName: transaction.executorName || null,
        assignedExecutorId: transaction.assignedExecutorId ? stringId(transaction.assignedExecutorId) : null,
        assignedExecutorName: transaction.assignedExecutorName || null,
        executorReceivedAt: transaction.executorReceivedAt || null,
        createdAt: transaction.createdAt || null,
        emergencyAlert: transaction.emergencyAlert || null
    };
};

module.exports = {
    buildExecutorTaskRecipient,
    isTaskOwnedByExecutor,
    taskRecipientPrefix,
    taskRecipientValue,
    toExecutorPortalTaskDto
};
