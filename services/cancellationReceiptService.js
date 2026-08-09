'use strict';

const fs = require('fs');
const path = require('path');
const Transaction = require('../models/Transaction');
const Counter = require('../models/Counter');
const { proofFilePath } = require('./proofStorageService');
const { generateExecutorReceiptBase64 } = require('../utils/manualExecutorReceipt');

const safeFileId = (value) => String(value || `cancel-${Date.now()}`).replace(/[^\w.-]/g, '_');

const nextCancellationNumber = async () => {
    const now = new Date();
    const year = String(now.getFullYear()).slice(-2);
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const counter = await Counter.findOneAndUpdate(
        { name: `cancellation-${year}${month}` },
        { $inc: { value: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return `CAN-${year}${month}-${String(counter.value).padStart(5, '0')}`;
};

const createCancellationReceiptProof = ({
    tx,
    reason,
    cancellationNumber,
    performedBy,
    cancelledAt
}) => {
    const safeId = safeFileId(cancellationNumber || tx.customId || tx._id);
    const fileName = `${safeId}_cancellation_receipt.jpg`;
    const fullPath = proofFilePath(fileName);
    const proofId = `proofs/${fileName}`;
    const receiptBase64 = generateExecutorReceiptBase64({
        status: 'cancelled',
        amount: tx.amount,
        customerPhone: tx.vodafoneNumber || tx.accountNumber || tx.serviceDetails?.clientPhone || '---',
        customId: tx.customId || '---',
        serviceName: tx.transferType === 'sefa_niger' ? 'سيفا النيجر' : 'محافظ كاش',
        amountCurrencyLabel: tx.transferType === 'sefa_niger' ? 'سيفا' : 'ج.م',
        transferType: tx.transferType,
        cancellationNumber: cancellationNumber || tx.cancellationNumber || '---',
        cancellationReason: reason || tx.cancellationReason || 'غير محدد',
        cancelledAt: cancelledAt || tx.cancelledAt || new Date(),
        performedBy: performedBy || tx.cancelledBy || 'النظام'
    });
    const imageData = String(receiptBase64 || '').replace(/^data:image\/(?:jpeg|jpg);base64,/i, '');
    const buffer = Buffer.from(imageData, 'base64');
    if (!buffer.length) throw new Error('CANCELLATION_RECEIPT_GENERATION_FAILED');

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, buffer);
    return proofId;
};

const attachCancellationReceipt = async (txInput, metadata = {}) => {
    if (!txInput) return null;
    const hasSaveMethod = typeof txInput.save === 'function';
    const transactionId = hasSaveMethod
        ? null
        : (typeof txInput === 'string' || typeof txInput?.toHexString === 'function'
            ? txInput
            : (txInput._id || txInput.id));
    const tx = hasSaveMethod ? txInput : await Transaction.findById(transactionId);
    if (!tx) return null;

    const cancellationNumber = metadata.cancellationNumber || tx.cancellationNumber || await nextCancellationNumber();
    tx.cancellationNumber = tx.cancellationNumber || cancellationNumber;
    tx.cancellationReason = tx.cancellationReason || metadata.reason || '';
    tx.cancelledBy = tx.cancelledBy || metadata.performedBy || 'النظام';
    tx.cancelledAt = tx.cancelledAt || metadata.cancelledAt || new Date();

    const existingImages = Array.isArray(tx.proofImages) ? tx.proofImages.filter(Boolean) : [];
    const existingCancellationReceipt = existingImages.find((item) => /_cancellation_receipt\.(?:svg|jpe?g)$/i.test(String(item)));
    if (existingCancellationReceipt) {
        tx.resolutionImage = existingCancellationReceipt;
        tx.proofImage = existingCancellationReceipt;
        await tx.save();
        return existingCancellationReceipt;
    }

    const proofId = createCancellationReceiptProof({
        tx,
        reason: metadata.reason,
        cancellationNumber,
        performedBy: metadata.performedBy,
        cancelledAt: metadata.cancelledAt
    });

    tx.resolutionImage = proofId;
    tx.proofImage = proofId;
    tx.proofImages = [proofId, ...existingImages.filter((item) => item !== proofId)];
    await tx.save();
    return proofId;
};

module.exports = {
    createCancellationReceiptProof,
    attachCancellationReceipt
};
