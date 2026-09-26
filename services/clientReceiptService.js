'use strict';

const { sanitizeStatementTransaction } = require('../utils/accountStatementPrivacy');
const { describeSplitPartProofs, listSplitCustomerProofIds } = require('../utils/splitPartProofs');

const CANCELLATION_RECEIPT_PATTERN = /_cancellation_receipt\.(?:svg|jpe?g)$/i;
const CANCELLED_RECEIPT_STATUSES = new Set(['rejected', 'cancelled_by_admin', 'cancelled', 'canceled']);

const orderedProofIds = (transaction = {}) => {
    const values = [
        transaction.proofImage,
        ...(Array.isArray(transaction.proofImages) ? transaction.proofImages : [])
    ];
    const seen = new Set();
    const ids = [];
    values.forEach((value) => {
        const proofId = String(value || '').trim();
        if (!proofId || proofId === 'protected' || seen.has(proofId)) return;
        seen.add(proofId);
        ids.push(proofId);
    });
    return ids;
};

const getClientReceiptProofIds = (transaction = {}) => {
    // The first proof is what the client receives. Cash keeps a generated
    // receipt there; a bank transfer stores the executor's attached proof
    // instead and does not generate a second image. Executor-only attachments
    // stay in executorProofImages and are kept out of every customer-facing
    // response. A cancelled operation prefers its cancellation receipt even
    // if an older success image is still stored beside it.
    const ids = orderedProofIds(transaction);
    const cancelled = CANCELLED_RECEIPT_STATUSES.has(String(transaction.status || '').toLowerCase());
    if (cancelled) {
        const cancellationId = ids.find((proofId) => CANCELLATION_RECEIPT_PATTERN.test(proofId));
        if (cancellationId) return [cancellationId];
    }
    const splitIds = listSplitCustomerProofIds(transaction);
    if (splitIds) return splitIds;
    if (!ids.length) return [];
    return [ids[0]];
};

const buildClientReceiptImages = (transaction = {}) => {
    const transactionId = String(transaction._id || transaction.id || '').trim();
    if (!transactionId) return [];

    const partProofs = describeSplitPartProofs(transaction).filter((part) => part.proofAvailable);
    if (partProofs.length) {
        return partProofs.map((part) => ({
            index: part.receiptIndex,
            label: `إثبات الجزء ${part.partId} — ${part.amount} من ${part.senderWallet}`,
            url: `/client/proxy/image/${encodeURIComponent(transactionId)}/${part.receiptIndex}`,
            partId: part.partId,
            amount: part.amount,
            senderWallet: part.senderWallet,
            recipient: part.recipient,
            reference: part.partReference,
            confirmedAt: part.confirmedAt,
            status: part.status
        }));
    }

    const transferType = String(transaction.transferType || transaction.canonicalServiceKey || '').trim().toLowerCase();
    const isSefaProof = transferType === 'sefa_niger';
    const isBankProof = transferType === 'bank_account' || transferType === 'bank_transfer';
    return getClientReceiptProofIds(transaction).map((_proofId, index) => ({
        index,
        label: isSefaProof && index === 0
            ? 'إثبات تنفيذ سيفا'
            : (isBankProof && index === 0 ? 'إثبات التحويل البنكي' : `صورة الإثبات ${index + 1}`),
        url: `/client/proxy/image/${encodeURIComponent(transactionId)}/${index}`
    }));
};

const presentClientVisibleReceipts = (transaction = {}) => {
    const receiptImages = buildClientReceiptImages(transaction);
    const partProofs = describeSplitPartProofs(transaction).map((part) => ({
        partId: part.partId,
        amount: part.amount,
        senderWallet: part.senderWallet,
        recipient: part.recipient,
        reference: part.reference,
        partReference: part.partReference,
        status: part.status,
        confirmedAt: part.confirmedAt,
        proofStatus: part.proofStatus,
        proofAvailable: part.proofAvailable,
        receiptIndex: part.receiptIndex
    }));
    return {
        hasProof: receiptImages.length > 0,
        receiptImages,
        ...(partProofs.length ? { partProofs } : {}),
        proofImage: receiptImages.length ? 'protected' : '',
        proofImages: receiptImages.length ? ['protected'] : []
    };
};

const presentClientPortalTransaction = (transaction = {}) => ({
    ...sanitizeStatementTransaction(transaction),
    ...presentClientVisibleReceipts(transaction)
});

module.exports = {
    CANCELLATION_RECEIPT_PATTERN,
    buildClientReceiptImages,
    getClientReceiptProofIds,
    presentClientPortalTransaction,
    presentClientVisibleReceipts
};
