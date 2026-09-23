'use strict';

// Bank transfer uses the existing service discriminator (`bank_account`,
// with the legacy `bank_transfer` alias already present in admin labels).
// Instapay stays on the same service key; this helper does not add a new flag.

const BANK_TRANSFER_TYPES = new Set(['bank_account', 'bank_transfer']);

const BANK_TRANSFER_SPLIT_ERROR = 'التحويل البنكي يُنفَّذ دفعة واحدة ولا يقبل التقسيم.';
const BANK_TRANSFER_PROOF_ERROR = 'إرفاق صورة إثبات التحويل البنكي إجباري.';
const BANK_TRANSFER_PROOF_NOTE = '[تم إرفاق إثبات التحويل البنكي وإرساله للعميل]';

class BankTransferExecutionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BankTransferExecutionError';
        this.code = code;
        this.statusCode = 400;
    }
}

const normalizedServiceType = (value) => String(value || '').trim().toLowerCase();

const isBankTransferOperation = (transaction = {}) => {
    const transferType = normalizedServiceType(transaction.transferType);
    const canonicalServiceKey = normalizedServiceType(transaction.canonicalServiceKey);
    return BANK_TRANSFER_TYPES.has(transferType) || BANK_TRANSFER_TYPES.has(canonicalServiceKey);
};

const pushProofPayload = (images, value) => {
    const image = String(value || '').trim();
    if (!image || images.includes(image)) return;
    images.push(image);
};

const collectBankTransferProofPayloads = (body = {}) => {
    const images = [];
    if (Array.isArray(body.imagesBase64) && body.imagesBase64.length) {
        body.imagesBase64.forEach((image) => pushProofPayload(images, image));
    } else {
        pushProofPayload(images, body.imageBase64);
    }
    if (Array.isArray(body.senderEntries)) {
        body.senderEntries.forEach((entry) => {
            pushProofPayload(images, entry?.proofImageBase64 || entry?.proofImage);
        });
    }
    return images;
};

const prepareBankTransferCompletion = (body = {}) => {
    const entries = Array.isArray(body.senderEntries)
        ? body.senderEntries.filter((entry) => entry && typeof entry === 'object')
        : [];
    if (entries.length > 1) {
        throw new BankTransferExecutionError('BANK_TRANSFER_SPLIT_FORBIDDEN', BANK_TRANSFER_SPLIT_ERROR);
    }
    const proofs = collectBankTransferProofPayloads(body);
    if (!proofs.length) {
        throw new BankTransferExecutionError('BANK_TRANSFER_PROOF_REQUIRED', BANK_TRANSFER_PROOF_ERROR);
    }
    return { proofs };
};

module.exports = {
    BANK_TRANSFER_PROOF_ERROR,
    BANK_TRANSFER_PROOF_NOTE,
    BANK_TRANSFER_SPLIT_ERROR,
    BANK_TRANSFER_TYPES,
    BankTransferExecutionError,
    collectBankTransferProofPayloads,
    isBankTransferOperation,
    prepareBankTransferCompletion
};
