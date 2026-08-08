'use strict';

const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const { acquireLock, releaseLock } = require('./lockService');

const SAME_AMOUNT_COOLDOWN_MS = 5 * 60 * 1000;
const DIFFERENT_AMOUNT_COOLDOWN_MS = 2 * 60 * 1000;
const LOCK_TTL_MS = 45 * 1000;
const BLOCKING_STATUSES = Object.freeze(['pending', 'processing', 'accepted', 'completed']);

class TransferCooldownError extends Error {
    constructor({ code, cooldownType, retryAfterSeconds, retryAt, message }) {
        super(message);
        this.name = 'TransferCooldownError';
        this.code = code;
        this.statusCode = 429;
        this.cooldownType = cooldownType;
        this.retryAfterSeconds = retryAfterSeconds;
        this.retryAt = retryAt;
    }
}

const arabicDigits = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
};

const normalizeTransferRecipient = (value) => {
    const raw = String(value ?? '')
        .trim()
        .replace(/[٠-٩]/g, (digit) => arabicDigits[digit]);

    if (!raw) return '';

    const compact = raw.replace(/[\s\-()./\\]+/g, '');
    if (!/^\+?\d+$/.test(compact)) return compact.toUpperCase();

    const digits = compact.replace(/^\+/, '');
    if (/^0020(1\d{9})$/.test(digits)) return `0${digits.slice(4)}`;
    if (/^20(1\d{9})$/.test(digits)) return `0${digits.slice(2)}`;
    return digits;
};

const normalizeTransferAmount = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return Number(amount.toFixed(3));
};

const normalizeServiceKey = (value) => String(value || '').trim().toLowerCase();

const buildRequestOwnerKey = ({ modelName, id }) => {
    const safeModelName = String(modelName || '').trim();
    const safeId = String(id || '').trim();
    if (!safeModelName || !safeId) {
        throw new Error('TRANSFER_COOLDOWN_CONTEXT_INVALID');
    }
    return `wallet:${safeModelName}:${safeId}`;
};

const buildCooldownLockKey = ({ requestOwnerKey, canonicalServiceKey, canonicalRecipient }) => {
    const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify({ requestOwnerKey, canonicalServiceKey, canonicalRecipient }))
        .digest('hex');
    return `transfer-cooldown:${fingerprint}`;
};

const isSameAmount = (left, right) => Number(left).toFixed(3) === Number(right).toFixed(3);

const getRetryDetails = (tx, cooldownMs, now) => {
    const createdAt = new Date(tx.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return null;

    const retryAtMs = createdAt + cooldownMs;
    if (retryAtMs <= now) return null;

    return {
        retryAfterSeconds: Math.max(1, Math.ceil((retryAtMs - now) / 1000)),
        retryAt: new Date(retryAtMs).toISOString()
    };
};

const findLatestMatchingTransaction = async (filter) => {
    const query = Transaction.findOne(filter);

    if (!query || typeof query.sort !== 'function') return null;

    const sortedQuery = query.sort({ createdAt: -1 });
    if (typeof sortedQuery.lean === 'function') return sortedQuery.lean();
    return sortedQuery;
};

const createCooldownError = ({ cooldownType, retryAfterSeconds, retryAt }) => {
    const isSameAmountCooldown = cooldownType === 'same_amount';
    return new TransferCooldownError({
        code: 'TRANSFER_COOLDOWN_ACTIVE',
        cooldownType,
        retryAfterSeconds,
        retryAt,
        message: isSameAmountCooldown
            ? `لا يمكن إعادة تحويل المبلغ نفسه إلى هذا الرقم الآن. أعد المحاولة بعد ${retryAfterSeconds} ثانية.`
            : `تم إدخال تحويل سابق إلى الرقم نفسه بقيمة مختلفة. أعد المحاولة بعد ${retryAfterSeconds} ثانية.`
    });
};

const acquireTransferCooldown = async ({ ownerKey, ownerModel, ownerId, serviceKey, recipient, amount, now = Date.now() }) => {
    const requestOwnerKey = ownerKey || buildRequestOwnerKey({ modelName: ownerModel, id: ownerId });
    const canonicalServiceKey = normalizeServiceKey(serviceKey);
    const canonicalRecipient = normalizeTransferRecipient(recipient);
    const normalizedAmount = normalizeTransferAmount(amount);

    if (!canonicalServiceKey || !canonicalRecipient || normalizedAmount === null) {
        throw new Error('TRANSFER_COOLDOWN_CONTEXT_INVALID');
    }

    let lock;
    try {
        lock = await acquireLock(
            buildCooldownLockKey({ requestOwnerKey, canonicalServiceKey, canonicalRecipient }),
            LOCK_TTL_MS,
            { retryCount: 2, retryDelay: 100 }
        );
    } catch (_error) {
        throw new TransferCooldownError({
            code: 'TRANSFER_COOLDOWN_LOCK_TIMEOUT',
            cooldownType: 'in_progress',
            retryAfterSeconds: 2,
            retryAt: new Date(now + 2000).toISOString(),
            message: 'هناك طلب تحويل مماثل قيد المعالجة. يرجى المحاولة بعد ثانيتين.'
        });
    }

    const baseFilter = {
        requestOwnerKey,
        canonicalServiceKey,
        canonicalRecipient,
        status: { $in: BLOCKING_STATUSES }
    };

    try {
        const exactMatch = await findLatestMatchingTransaction({
            ...baseFilter,
            amount: normalizedAmount,
            createdAt: { $gte: new Date(now - SAME_AMOUNT_COOLDOWN_MS) }
        });
        const exactRetry = exactMatch && isSameAmount(exactMatch.amount, normalizedAmount)
            ? getRetryDetails(exactMatch, SAME_AMOUNT_COOLDOWN_MS, now)
            : null;
        if (exactRetry) {
            throw createCooldownError({ cooldownType: 'same_amount', ...exactRetry });
        }

        const differentMatch = await findLatestMatchingTransaction({
            ...baseFilter,
            amount: { $ne: normalizedAmount },
            createdAt: { $gte: new Date(now - DIFFERENT_AMOUNT_COOLDOWN_MS) }
        });
        const differentRetry = differentMatch && !isSameAmount(differentMatch.amount, normalizedAmount)
            ? getRetryDetails(differentMatch, DIFFERENT_AMOUNT_COOLDOWN_MS, now)
            : null;
        if (differentRetry) {
            throw createCooldownError({ cooldownType: 'different_amount', ...differentRetry });
        }

        return {
            lock,
            guardFields: {
                requestOwnerKey,
                canonicalServiceKey,
                canonicalRecipient
            }
        };
    } catch (error) {
        await releaseLock(lock);
        throw error;
    }
};

const releaseTransferCooldown = async (lock) => releaseLock(lock);

module.exports = {
    BLOCKING_STATUSES,
    DIFFERENT_AMOUNT_COOLDOWN_MS,
    SAME_AMOUNT_COOLDOWN_MS,
    TransferCooldownError,
    acquireTransferCooldown,
    buildRequestOwnerKey,
    normalizeTransferAmount,
    normalizeTransferRecipient,
    releaseTransferCooldown
};
