'use strict';

const fs = require('fs');
const path = require('path');
const { generateManualExecutorReceiptBase64 } = require('../utils/manualExecutorReceipt');
const { parseExecutorImageDataUrl } = require('../utils/executorImageValidation');

const MAX_PROOF_IMAGES = 5;
const MAX_PROOF_BYTES = 8 * 1024 * 1024;
const parseProofImage = (value) => {
    return parseExecutorImageDataUrl(value, {
        maxBytes: MAX_PROOF_BYTES,
        allowWrappedBase64: true,
        errorCode: 'INVALID_PROOF_IMAGE'
    });
};

const getProofImages = (body = {}) => {
    const rawImages = Array.isArray(body.imagesBase64) && body.imagesBase64.length
        ? body.imagesBase64
        : (body.imageBase64 ? [body.imageBase64] : []);
    if (rawImages.length === 0) return [];
    if (rawImages.length > MAX_PROOF_IMAGES) throw new Error('TOO_MANY_PROOFS');
    return rawImages.map(parseProofImage);
};

const saveProofBuffer = ({ tx, proofsDir, savedPaths, buffer, extension, suffix = '' }) => {
    const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `${safeId}_${Date.now().toString(36)}${suffix ? `_${suffix}` : ''}.${extension}`;
    const filePath = path.join(proofsDir, fileName);
    fs.writeFileSync(filePath, buffer);
    savedPaths.push(filePath);
    return fileName;
};

const saveProofImageBase64 = ({ tx, proofsDir, savedPaths, imageBase64, suffix = '' }) => {
    if (!imageBase64) return null;
    const parsed = parseProofImage(imageBase64);
    return saveProofBuffer({
        tx,
        proofsDir,
        savedPaths,
        buffer: parsed.buffer,
        extension: parsed.extension,
        suffix
    });
};

const generateManualExecutorReceiptProof = async ({ tx, executionNumber, executorReference, proofsDir, savedPaths }) => {
    const receiptBase64 = await generateManualExecutorReceiptBase64({
        amount: tx.amount,
        customerPhone: tx.vodafoneNumber || tx.accountNumber || tx.serviceDetails?.clientPhone || '---',
        executionNumber,
        customId: tx.customId || tx._id.toString().slice(-6),
        executorReference,
        serviceName: tx.transferType === 'sefa_niger' ? 'سيفا النيجر' : 'محافظ كاش',
        amountCurrencyLabel: tx.transferType === 'sefa_niger' ? 'سيفا' : 'ج.م',
        transferType: tx.transferType,
        completedAt: tx.completedAt || new Date()
    });
    let buffer;
    try {
        ({ buffer } = parseProofImage(receiptBase64));
    } catch (_) {
        throw new Error('AUTO_RECEIPT_GENERATION_FAILED');
    }

    const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `${safeId}_manual_${Date.now().toString(36)}.jpg`;
    const filePath = path.join(proofsDir, fileName);
    fs.writeFileSync(filePath, buffer);
    savedPaths.push(filePath);
    return fileName;
};

const saveProviderReceiptProof = ({ tx, receiptBase64 }) => {
    const parsed = parseProofImage(receiptBase64);
    const proofsDir = path.join(process.cwd(), 'uploads', 'proofs');
    if (!fs.existsSync(proofsDir)) fs.mkdirSync(proofsDir, { recursive: true });
    const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `${safeId}_zaynpay.${parsed.extension}`;
    fs.writeFileSync(path.join(proofsDir, fileName), parsed.buffer);
    return fileName;
};

module.exports = {
    MAX_PROOF_IMAGES,
    getProofImages,
    saveProofBuffer,
    saveProofImageBase64,
    generateManualExecutorReceiptProof,
    saveProviderReceiptProof
};
