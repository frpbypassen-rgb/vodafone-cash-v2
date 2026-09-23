'use strict';

const { sanitizeStatementTransaction } = require('../utils/accountStatementPrivacy');

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
    // The first proof is the official system receipt. Executor attachments are
    // deliberately kept out of every customer-facing response. A cancelled
    // operation prefers its cancellation receipt even if an older success
    // image is still stored beside it.
    const ids = orderedProofIds(transaction);
    if (!ids.length) return [];
    const cancelled = CANCELLED_RECEIPT_STATUSES.has(String(transaction.status || '').toLowerCase());
    if (cancelled) {
        const cancellationId = ids.find((proofId) => CANCELLATION_RECEIPT_PATTERN.test(proofId));
        if (cancellationId) return [cancellationId];
    }
    return [ids[0]];
};

const buildClientReceiptImages = (transaction = {}) => {
    const transactionId = String(transaction._id || transaction.id || '').trim();
    if (!transactionId) return [];

    const isSefaProof = String(transaction.transferType || '').trim() === 'sefa_niger';
    return getClientReceiptProofIds(transaction).map((_proofId, index) => ({
        index,
        label: isSefaProof && index === 0 ? 'إثبات تنفيذ سيفا' : `صورة الإثبات ${index + 1}`,
        url: `/client/proxy/image/${encodeURIComponent(transactionId)}/${index}`
    }));
};

const presentClientVisibleReceipts = (transaction = {}) => {
    const receiptImages = buildClientReceiptImages(transaction);
    return {
        hasProof: receiptImages.length > 0,
        receiptImages,
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
