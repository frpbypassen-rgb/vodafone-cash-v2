'use strict';

const PART_STATUSES = new Set(['pending', 'success', 'failed', 'cancelled']);
const SUCCESS_PART_STATUS = 'success';

const trackedSplitEntries = (transaction = {}) => {
    const entries = Array.isArray(transaction.executorSenderEntries) ? transaction.executorSenderEntries : [];
    const tracked = entries.filter((entry) => entry && entry.partId && entry.customerProof && entry.customerProof.key);
    return tracked.length > 1 ? tracked : null;
};

const isSplitPartProofTransfer = (transaction = {}) => Boolean(trackedSplitEntries(transaction));

const listSplitCustomerProofIds = (transaction = {}) => {
    const tracked = trackedSplitEntries(transaction);
    if (!tracked) return null;
    return tracked
        .filter((entry) => entry.status === SUCCESS_PART_STATUS)
        .map((entry) => String(entry.customerProof.imageId || '').trim())
        .filter(Boolean);
};

const transferRecipientNumber = (transaction = {}) => String(
    transaction.vodafoneNumber || transaction.accountNumber || ''
).trim();

const normalizeRequestedPartStatus = (value) => {
    const status = String(value || '').trim().toLowerCase();
    return PART_STATUSES.has(status) ? status : SUCCESS_PART_STATUS;
};

const preparePersistedSenderEntries = ({
    transactionId,
    entries,
    completedAt,
    requestedEntries = []
} = {}) => {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length < 2) {
        return list.map((entry) => ({
            phone: entry.phone,
            amount: entry.amount,
            proofImage: entry.proofImage || null
        }));
    }

    const confirmedAt = completedAt instanceof Date ? completedAt : new Date(completedAt || Date.now());
    return list.map((entry, index) => {
        const status = normalizeRequestedPartStatus(requestedEntries[index]?.status);
        const partId = String(index + 1);
        const persisted = {
            phone: entry.phone,
            amount: entry.amount,
            proofImage: entry.proofImage || null,
            partId,
            status,
            customerProof: {
                key: `${String(transactionId)}:${partId}`,
                status: 'pending',
                imageId: null,
                attempts: 0,
                lastError: ''
            }
        };
        if (status === SUCCESS_PART_STATUS) persisted.confirmedAt = confirmedAt;
        return persisted;
    });
};

const findSplitPart = (transaction, partId) => {
    const entries = Array.isArray(transaction?.executorSenderEntries) ? transaction.executorSenderEntries : [];
    return entries.find((entry) => String(entry?.partId || '') === String(partId || '')) || null;
};

const partProofFacts = (transaction, entry) => {
    const partId = String(entry?.partId || '').trim();
    const wallet = String(entry?.phone || '').trim();
    const amount = Number(entry?.amount);
    const confirmedAt = entry?.confirmedAt ? new Date(entry.confirmedAt) : null;
    const recipient = transferRecipientNumber(transaction);
    const reference = String(transaction?.customId || transaction?._id || '').trim();
    const missing = [];
    if (!partId) missing.push('partId');
    if (!wallet) missing.push('senderWallet');
    if (!Number.isFinite(amount) || amount <= 0) missing.push('amount');
    if (!confirmedAt || Number.isNaN(confirmedAt.getTime())) missing.push('confirmedAt');
    if (!recipient) missing.push('recipient');
    if (!reference) missing.push('reference');
    return {
        partId,
        wallet,
        amount,
        confirmedAt,
        recipient,
        reference,
        proofKey: String(entry?.customerProof?.key || '').trim(),
        missing
    };
};

const describeSplitPartProofs = (transaction = {}) => {
    const tracked = trackedSplitEntries(transaction);
    if (!tracked) return [];
    const imageIds = listSplitCustomerProofIds(transaction) || [];
    const recipient = transferRecipientNumber(transaction);
    const reference = String(transaction.customId || '').trim();
    return tracked.map((entry) => {
        const imageId = String(entry.customerProof?.imageId || '').trim();
        const receiptIndex = imageId ? imageIds.indexOf(imageId) : -1;
        return {
            partId: String(entry.partId),
            amount: Number(entry.amount),
            senderWallet: String(entry.phone || ''),
            recipient,
            reference,
            partReference: reference && entry.partId ? `${reference}:${entry.partId}` : '',
            status: entry.status || '',
            confirmedAt: entry.confirmedAt || null,
            proofStatus: entry.customerProof?.status || 'pending',
            proofAvailable: receiptIndex >= 0,
            receiptIndex: receiptIndex >= 0 ? receiptIndex : null,
            attempts: Number(entry.customerProof?.attempts || 0)
        };
    });
};

module.exports = {
    PART_STATUSES,
    SUCCESS_PART_STATUS,
    describeSplitPartProofs,
    findSplitPart,
    isSplitPartProofTransfer,
    listSplitCustomerProofIds,
    partProofFacts,
    preparePersistedSenderEntries,
    trackedSplitEntries,
    transferRecipientNumber
};
