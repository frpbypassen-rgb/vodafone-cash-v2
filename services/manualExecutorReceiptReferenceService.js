'use strict';

const Counter = require('../models/Counter');
const ExecutorGroup = require('../models/ExecutorGroup');

const PREFIX_COUNTER_NAME = 'manual-executor-receipt-prefix';

class ManualExecutorReceiptReferenceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ManualExecutorReceiptReferenceError';
        this.code = code;
    }
}

const normalizeManualExecutorReceiptPrefix = (value) => {
    const prefix = String(value || '').trim();
    if (!/^\d{3}$/.test(prefix)) {
        throw new ManualExecutorReceiptReferenceError(
            'INVALID_MANUAL_RECEIPT_PREFIX',
            'رمز مرجع المنفذ يجب أن يتكون من 3 أرقام.'
        );
    }
    return prefix;
};

const nextCounterValue = async (name) => {
    const counter = await Counter.findOneAndUpdate(
        { name },
        { $inc: { value: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const value = Number(counter?.value);
    if (!Number.isInteger(value) || value < 1) {
        throw new ManualExecutorReceiptReferenceError(
            'MANUAL_RECEIPT_COUNTER_FAILED',
            'تعذر إنشاء الرقم التسلسلي للإيصال.'
        );
    }
    return value;
};

const allocateManualExecutorReceiptPrefix = async () => {
    for (let attempts = 0; attempts < 900; attempts += 1) {
        const ordinal = await nextCounterValue(PREFIX_COUNTER_NAME);
        const prefixNumber = 99 + ordinal;
        if (prefixNumber > 999) break;
        const prefix = String(prefixNumber).padStart(3, '0');
        const alreadyUsed = await ExecutorGroup.exists({ manualReceiptPrefix: prefix });
        if (!alreadyUsed) return prefix;
    }

    throw new ManualExecutorReceiptReferenceError(
        'MANUAL_RECEIPT_PREFIX_EXHAUSTED',
        'لا توجد رموز مرجعية ثلاثية متاحة للمنفذين الجدد.'
    );
};

const reserveManualExecutorReceiptPrefix = async (requestedPrefix = '') => {
    const requested = String(requestedPrefix || '').trim();
    if (!requested) return allocateManualExecutorReceiptPrefix();

    const prefix = normalizeManualExecutorReceiptPrefix(requested);
    const alreadyUsed = await ExecutorGroup.exists({ manualReceiptPrefix: prefix });
    if (alreadyUsed) {
        throw new ManualExecutorReceiptReferenceError(
            'MANUAL_RECEIPT_PREFIX_TAKEN',
            'رمز مرجع المنفذ مستخدم بالفعل.'
        );
    }
    return prefix;
};

const ensureGroupReceiptPrefix = async (group) => {
    const existing = String(group?.manualReceiptPrefix || '').trim();
    if (existing) return normalizeManualExecutorReceiptPrefix(existing);
    if (!group?._id) {
        throw new ManualExecutorReceiptReferenceError(
            'MISSING_EXECUTOR_GROUP',
            'تعذر تحديد المنفذ لإنشاء المرجع.'
        );
    }

    for (let attempts = 0; attempts < 3; attempts += 1) {
        const prefix = await allocateManualExecutorReceiptPrefix();
        const claimedGroup = await ExecutorGroup.findOneAndUpdate(
            {
                _id: group._id,
                $or: [
                    { manualReceiptPrefix: { $exists: false } },
                    { manualReceiptPrefix: null },
                    { manualReceiptPrefix: '' }
                ]
            },
            { $set: { manualReceiptPrefix: prefix } },
            { new: true }
        );
        if (claimedGroup?.manualReceiptPrefix) return normalizeManualExecutorReceiptPrefix(claimedGroup.manualReceiptPrefix);

        const refreshedGroup = await ExecutorGroup.findById(group._id);
        if (refreshedGroup?.manualReceiptPrefix) return normalizeManualExecutorReceiptPrefix(refreshedGroup.manualReceiptPrefix);
    }

    throw new ManualExecutorReceiptReferenceError(
        'MANUAL_RECEIPT_PREFIX_ASSIGN_FAILED',
        'تعذر تخصيص رمز مرجع المنفذ.'
    );
};

const reserveManualExecutorReceiptReference = async ({ group }) => {
    const prefix = await ensureGroupReceiptPrefix(group);
    const groupId = String(group._id);
    const sequence = await nextCounterValue(`manual-executor-receipt-sequence:${groupId}`);
    return {
        prefix,
        sequence,
        reference: `${prefix}${String(sequence).padStart(3, '0')}`
    };
};

module.exports = {
    ManualExecutorReceiptReferenceError,
    normalizeManualExecutorReceiptPrefix,
    reserveManualExecutorReceiptPrefix,
    reserveManualExecutorReceiptReference
};
