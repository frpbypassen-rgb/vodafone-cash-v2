'use strict';

const fs = require('fs');
const path = require('path');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const manualExecutorReceipt = require('../utils/manualExecutorReceipt');
const { sendSplitPartReceipt } = require('./whatsappReceiptDeliveryService');
const {
    describeSplitPartProofs,
    findSplitPart,
    isSplitPartProofTransfer,
    partProofFacts
} = require('../utils/splitPartProofs');

const PROOF_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'proofs');
const AUTOMATIC_CLAIM_STATUSES = ['pending', 'failed'];
const RETRY_CLAIM_STATUSES = ['pending', 'failed', 'generated', 'generating', 'unavailable'];

const safeProofError = (error) => {
    const message = String(error?.message || error || 'PART_PROOF_FAILED').replace(/\s+/g, ' ').trim();
    if (/bearer|token|secret|authorization|cookie|api[_-]?key|signature/i.test(message)) {
        return 'PART_PROOF_FAILED';
    }
    return message.slice(0, 300) || 'PART_PROOF_FAILED';
};

const logPartProof = (level, message, transaction, partId, extra = {}) => {
    logger[level](message, {
        customId: transaction?.customId || undefined,
        transactionId: transaction?._id ? String(transaction._id) : undefined,
        partId: partId || undefined,
        ...extra
    });
};

const serviceLabelFor = (transaction) => (
    transaction?.transferType === 'sefa_niger' ? 'سيفا النيجر' : 'محافظ كاش'
);

const currencyLabelFor = (transaction) => (
    transaction?.transferType === 'sefa_niger' ? 'سيفا' : 'ج.م'
);

const savePartProofFile = (transaction, partId, dataUrl) => {
    const payload = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(payload, 'base64');
    if (!buffer.length) {
        const error = new Error('PART_PROOF_IMAGE_EMPTY');
        error.code = 'PART_PROOF_IMAGE_EMPTY';
        throw error;
    }
    const safeId = String(transaction.customId || transaction._id).replace(/[^\w.-]/g, '_');
    const safePart = String(partId).replace(/[^\w.-]/g, '_');
    const fileName = `${safeId}_part_${safePart}.jpg`;
    fs.mkdirSync(PROOF_UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROOF_UPLOAD_DIR, fileName), buffer);
    return `proofs/${fileName}`;
};

const renderPartProof = async (transaction, facts) => manualExecutorReceipt.generateManualExecutorReceiptBase64({
    amount: facts.amount,
    customerPhone: facts.recipient,
    executionNumber: facts.wallet,
    executionNumberLabel: 'المحفظة المرسلة',
    customId: facts.reference,
    executorReference: `${facts.reference}:${facts.partId}`,
    executionReferenceLabel: 'المرجع والجزء',
    serviceName: serviceLabelFor(transaction),
    amountCurrencyLabel: currencyLabelFor(transaction),
    transferType: transaction.transferType,
    completedAt: facts.confirmedAt,
    status: 'completed'
});

const successProofImagesExpression = {
    $map: {
        input: {
            $filter: {
                input: { $ifNull: ['$executorSenderEntries', []] },
                as: 'entry',
                cond: {
                    $and: [
                        { $eq: ['$$entry.status', 'success'] },
                        { $gt: [{ $strLenCP: { $ifNull: ['$$entry.customerProof.imageId', ''] } }, 0] }
                    ]
                }
            }
        },
        as: 'entry',
        in: '$$entry.customerProof.imageId'
    }
};

const syncCustomerProofList = async (transactionId) => Transaction.updateOne({ _id: transactionId }, [
    { $set: { proofImages: successProofImagesExpression } },
    { $set: { proofImage: { $arrayElemAt: ['$proofImages', 0] } } }
]);

const setPartProofState = async (transactionId, partId, fields) => {
    const set = {};
    Object.entries(fields).forEach(([key, value]) => {
        set[`executorSenderEntries.$.customerProof.${key}`] = value;
    });
    return Transaction.findOneAndUpdate(
        { _id: transactionId, 'executorSenderEntries.partId': String(partId) },
        { $set: set },
        { new: true }
    );
};

const claimPartProof = async (transactionId, partId, proofKey, fromStatuses) => Transaction.findOneAndUpdate(
    {
        _id: transactionId,
        status: 'completed',
        executorSenderEntries: {
            $elemMatch: {
                partId: String(partId),
                status: 'success',
                'customerProof.key': proofKey,
                'customerProof.status': { $in: fromStatuses }
            }
        }
    },
    {
        $set: {
            'executorSenderEntries.$.customerProof.status': 'generating',
            'executorSenderEntries.$.customerProof.claimedAt': new Date(),
            'executorSenderEntries.$.customerProof.lastError': ''
        },
        $inc: { 'executorSenderEntries.$.customerProof.attempts': 1 }
    },
    { new: true }
);

const markUnavailable = async (transaction, entry, reason) => {
    logPartProof('warn', 'Split part proof unavailable', transaction, entry.partId, { reason });
    if (!entry.customerProof?.key) {
        return { ok: false, code: 'PART_PROOF_UNAVAILABLE', partId: entry.partId || null, proofStatus: 'unavailable', reason };
    }
    await setPartProofState(transaction._id, entry.partId, {
        status: 'unavailable',
        lastError: reason
    });
    return { ok: false, code: 'PART_PROOF_UNAVAILABLE', partId: String(entry.partId), proofStatus: 'unavailable', reason };
};

const issueSplitPartProof = async (transactionId, partId, { retry = false } = {}) => {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) return { ok: false, code: 'TRANSACTION_NOT_FOUND', partId: String(partId || '') };
    if (transaction.status !== 'completed') {
        return { ok: false, code: 'TRANSFER_NOT_COMPLETED', partId: String(partId || '') };
    }
    if (!isSplitPartProofTransfer(transaction)) {
        logPartProof('info', 'Split part proof skipped for a transfer without part proof identity', transaction, partId, {
            reason: 'LEGACY_OR_SINGLE_PROOF'
        });
        return { ok: false, code: 'PART_PROOF_NOT_TRACKED', partId: String(partId || '') };
    }

    const entry = findSplitPart(transaction, partId);
    if (!entry) return { ok: false, code: 'PART_NOT_FOUND', partId: String(partId || '') };
    if (entry.status !== 'success') {
        logPartProof('info', 'Split part proof skipped because the part is not successful', transaction, entry.partId, {
            reason: entry.status || 'missing'
        });
        return { ok: true, skipped: true, code: 'PART_NOT_SUCCESSFUL', partId: String(entry.partId), proofStatus: entry.customerProof?.status || null };
    }
    if (entry.customerProof?.status === 'sent') {
        return { ok: true, duplicate: true, code: 'PART_PROOF_ALREADY_SENT', partId: String(entry.partId), proofStatus: 'sent' };
    }

    const initialFacts = partProofFacts(transaction, entry);
    if (initialFacts.missing.length || !initialFacts.proofKey) {
        return markUnavailable(transaction, entry, `PART_PROOF_DATA_MISSING:${initialFacts.missing.join(',') || 'proofKey'}`);
    }

    const claimed = await claimPartProof(
        transaction._id,
        initialFacts.partId,
        initialFacts.proofKey,
        retry ? RETRY_CLAIM_STATUSES : AUTOMATIC_CLAIM_STATUSES
    );
    if (!claimed) {
        const current = findSplitPart(await Transaction.findById(transaction._id), initialFacts.partId);
        if (current?.customerProof?.status === 'sent') {
            return { ok: true, duplicate: true, code: 'PART_PROOF_ALREADY_SENT', partId: initialFacts.partId, proofStatus: 'sent' };
        }
        return { ok: true, duplicate: true, code: 'PART_PROOF_IN_PROGRESS', partId: initialFacts.partId, proofStatus: current?.customerProof?.status || null };
    }

    const claimedEntry = findSplitPart(claimed, initialFacts.partId);
    const facts = partProofFacts(claimed, claimedEntry);
    if (facts.missing.length || !facts.proofKey) {
        return markUnavailable(claimed, claimedEntry, `PART_PROOF_DATA_MISSING:${facts.missing.join(',') || 'proofKey'}`);
    }
    let imageId = String(claimedEntry?.customerProof?.imageId || '').trim();
    try {
        if (!imageId) {
            const dataUrl = await renderPartProof(claimed, facts);
            imageId = savePartProofFile(claimed, facts.partId, dataUrl);
            await setPartProofState(claimed._id, facts.partId, {
                status: 'generated',
                imageId,
                lastError: ''
            });
            await syncCustomerProofList(claimed._id);
        } else {
            await setPartProofState(claimed._id, facts.partId, {
                status: 'generated',
                imageId,
                lastError: ''
            });
            await syncCustomerProofList(claimed._id);
        }

        const delivery = await sendSplitPartReceipt({
            transactionId: claimed._id,
            partId: facts.partId,
            partKey: facts.proofKey,
            amount: facts.amount,
            confirmedAt: facts.confirmedAt,
            reference: `${facts.reference}:${facts.partId}`
        });
        if (!delivery?.success) {
            const reason = safeProofError(delivery?.message || delivery?.code || 'PART_PROOF_SEND_FAILED');
            await setPartProofState(claimed._id, facts.partId, {
                status: 'failed',
                imageId,
                lastError: reason
            });
            logPartProof('error', 'Split part proof send failed', claimed, facts.partId, { reason });
            return { ok: false, code: delivery?.code || 'PART_PROOF_SEND_FAILED', partId: facts.partId, proofStatus: 'failed' };
        }

        await setPartProofState(claimed._id, facts.partId, {
            status: 'sent',
            imageId,
            lastError: '',
            sentAt: new Date()
        });
        return {
            ok: true,
            code: delivery.duplicate ? 'PART_PROOF_ALREADY_SENT' : 'PART_PROOF_SENT',
            duplicate: Boolean(delivery.duplicate),
            partId: facts.partId,
            proofStatus: 'sent',
            imageId
        };
    } catch (error) {
        const reason = safeProofError(error);
        await setPartProofState(claimed._id, facts.partId, {
            status: 'failed',
            imageId: imageId || null,
            lastError: reason
        }).catch(() => {});
        logPartProof('error', 'Split part proof generation failed', claimed, facts.partId, { reason });
        return { ok: false, code: 'PART_PROOF_GENERATION_FAILED', partId: facts.partId, proofStatus: 'failed' };
    }
};

const issueSplitPartProofs = async (transactionId) => {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction || transaction.status !== 'completed' || !isSplitPartProofTransfer(transaction)) {
        return { ok: true, skipped: true, parts: [] };
    }
    const parts = [];
    for (const entry of transaction.executorSenderEntries) {
        if (!entry?.partId || !entry.customerProof?.key) continue;
        try {
            parts.push(await issueSplitPartProof(transaction._id, entry.partId, { retry: false }));
        } catch (error) {
            logPartProof('error', 'Split part proof issuer failed open', transaction, entry.partId, {
                reason: safeProofError(error)
            });
            parts.push({ ok: false, code: 'PART_PROOF_GENERATION_FAILED', partId: String(entry.partId), proofStatus: 'failed' });
        }
    }
    return { ok: true, parts };
};

const retrySplitPartProof = (transactionId, partId) => issueSplitPartProof(transactionId, partId, { retry: true });

module.exports = {
    describeSplitPartProofs,
    issueSplitPartProof,
    issueSplitPartProofs,
    retrySplitPartProof,
    safeProofError
};
