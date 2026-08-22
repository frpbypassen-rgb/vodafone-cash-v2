'use strict';

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
    operationAmount
}) => {
    const rawEntries = Array.isArray(requestedSenderEntries)
        ? requestedSenderEntries
        : (senderPhone ? [{ phone: senderPhone }] : []);
    const entries = rawEntries.map((entry) => ({
        phone: String(entry?.phone || '').trim(),
        amount: entry?.amount === undefined || entry?.amount === null || entry?.amount === ''
            ? null
            : Number(entry.amount)
    }));

    if (entries.some((entry) => !/^\d{11}$/.test(entry.phone))) {
        throw new ExecutorSenderEntriesError(
            'INVALID_SENDER_PHONE',
            'كل رقم مرسل يجب أن يتكون من 11 رقماً'
        );
    }

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

    return entries;
};

module.exports = {
    ExecutorSenderEntriesError,
    normalizeExecutorSenderEntries
};
