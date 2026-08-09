'use strict';

const getClientReceiptProofIds = (transaction = {}) => {
    const candidates = [
        ...(Array.isArray(transaction.proofImages) ? transaction.proofImages : []),
        transaction.proofImage
    ];
    const seen = new Set();

    return candidates.reduce((proofIds, candidate) => {
        const proofId = String(candidate || '').trim();
        if (!proofId || seen.has(proofId)) return proofIds;
        seen.add(proofId);
        proofIds.push(proofId);
        return proofIds;
    }, []);
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
