'use strict';

const { sanitizeStatementTransaction } = require('../utils/accountStatementPrivacy');

const getClientReceiptProofIds = (transaction = {}) => {
    // The first proof is the official system receipt. Executor attachments are
    // deliberately kept out of every customer-facing response.
    const proofId = String(
        transaction.proofImage
        || (Array.isArray(transaction.proofImages) ? transaction.proofImages[0] : '')
        || ''
    ).trim();
    if (!proofId || proofId === 'protected') return [];
    return [proofId];
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
    buildClientReceiptImages,
    getClientReceiptProofIds,
    presentClientPortalTransaction,
    presentClientVisibleReceipts
};
