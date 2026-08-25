'use strict';

const { validateSenderPhoneDigits, readExecutorManualPolicy } = require('./executorManualPolicy');

class ExecutorSenderEntriesError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ExecutorSenderEntriesError';
        this.code = code;
        this.statusCode = 400;
    }
}

const normalizeExecutorSenderEntries = ({
    requestedSenderEntries,
    senderPhone,
    operationAmount,
    group = null,
    policy = null
}) => {
    const manualPolicy = policy || readExecutorManualPolicy(group);
    const rawEntries = Array.isArray(requestedSenderEntries)
        ? requestedSenderEntries
        : (senderPhone ? [{ phone: senderPhone }] : []);
    const isSplit = rawEntries.length > 1;

    const entries = rawEntries.map((entry) => {
        const validation = validateSenderPhoneDigits(entry?.phone, {
            allowedPhoneLengths: manualPolicy.allowedPhoneLengths,
            splitRequiresFullPhone: manualPolicy.splitRequiresFullPhone,
            isSplit
        });
        if (!validation.ok) {
            throw new ExecutorSenderEntriesError(validation.code, validation.message);
        }
        return {
            phone: validation.digits,
            amount: entry?.amount === undefined || entry?.amount === null || entry?.amount === ''
                ? null
                : Number(entry.amount),
            proofImage: entry?.proofImage || entry?.proofImageBase64 || null
        };
    });

    if (entries.length > 1) {
        if (entries.some((entry) => !Number.isFinite(entry.amount) || entry.amount <= 0)) {
            throw new ExecutorSenderEntriesError(
                'SENDER_AMOUNTS_REQUIRED',
                'أدخل قيمة لكل رقم مرسل عند إدخال أكثر من رقم'
            );
        }
        const senderTotal = entries.reduce((sum, entry) => sum + entry.amount, 0);
        if (Math.abs(senderTotal - Number(operationAmount || 0)) > 0.01) {
            throw new ExecutorSenderEntriesError(
                'SENDER_AMOUNT_MISMATCH',
                'مجموع قيم أرقام المرسلين يجب أن يساوي قيمة العملية'
            );
        }
    } else if (entries.length === 1) {
        entries[0].amount = Number(operationAmount || 0);
    }

    if (manualPolicy.proofRequired && entries.length > 0) {
        if (entries.some((entry) => !entry.proofImage)) {
            throw new ExecutorSenderEntriesError(
                'PROOF_REQUIRED',
                'يجب إرفاق صورة إثبات لكل رقم مرسل.'
            );
        }
    }

    return entries.map(({ phone, amount, proofImage }) => ({ phone, amount, proofImage }));
};

module.exports = {
    ExecutorSenderEntriesError,
    normalizeExecutorSenderEntries
};
