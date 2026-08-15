'use strict';

const getClientReceiptProofIds = (transaction = {}) => {
    // The first proof is the official system receipt. Executor attachments are
    // deliberately kept out of every customer-facing response.
    const proofId = String(
        transaction.proofImage
        || (Array.isArray(transaction.proofImages) ? transaction.proofImages[0] : '')
        || ''
    ).trim();
    return proofId ? [proofId] : [];
};

const buildClientReceiptImages = (transaction = {}) => {
    const transactionId = String(transaction._id || transaction.id || '').trim();
    if (!transactionId) return [];

    const isSefaProof = String(transaction.transferType || '').trim() === 'sefa_niger';
    return getClientReceiptProofIds(transaction).map((_proofId, index) => ({
        index,
        label: isSefaProof && index === 0 ? 'إثبات تنفيذ سيفا' : `صورة الإيصال ${index + 1}`,
        url: `/client/proxy/image/${encodeURIComponent(transactionId)}/${index}`
    }));
};

module.exports = {
    buildClientReceiptImages,
    getClientReceiptProofIds
};
