'use strict';

const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const { acquireLock, releaseLock } = require('./lockService');
const { distributedStateRequired } = require('../config/runtimeScale');

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PUBLIC_MESSAGES = {
    TENANT_UNRESOLVED: 'تعذر تحديد المنظمة بأمان. لم يتم خصم أي مبلغ.',
    CROSS_TENANT_TRANSFER: 'لا يمكن التحويل إلى حساب خارج المنظمة. لم يتم خصم أي مبلغ.',
    CROSS_TENANT_ACCOUNT: 'لا يمكن الوصول إلى حساب خارج المنظمة.',
    IDEMPOTENCY_KEY_REQUIRED: 'مفتاح منع التكرار مطلوب لهذه العملية.',
    IDEMPOTENCY_KEY_INVALID: 'صيغة مفتاح منع التكرار غير صالحة.',
    IDEMPOTENCY_CONFLICT: 'مفتاح العملية مستخدم لطلب مختلف.',
    REDIS_LOCK_FAILED: 'تعذر قفل العملية بأمان. لم يتم خصم أي مبلغ.',
    MASTER_SUB_TENANT_MISMATCH: 'حساب نقطة البيع والحساب الرئيسي ليسا في نفس المنظمة.'
};

const tenantMode = () => {
    const configured = String(process.env.TENANT_MODE || '').trim().toLowerCase();
    return configured === 'multi' ? 'multi' : 'single';
};
const multiTenantMode = () => tenantMode() === 'multi';
// These flags are future safeguards for TENANT_MODE=multi only.
// أهرام باي runs as one organization. Turning a flag on while mode stays single must not reject a transfer.
const tenantGuardEnabled = () => truthy(process.env.FINANCIAL_TENANT_GUARD) && multiTenantMode();
const idempotencyRequired = () => truthy(process.env.FINANCIAL_IDEMPOTENCY_REQUIRED);
const idempotencyEnabled = () => idempotencyRequired() || truthy(process.env.FINANCIAL_IDEMPOTENCY_ENABLED);
const strictIdempotencyBinding = () => truthy(process.env.FINANCIAL_IDEMPOTENCY_STRICT_BINDING);
const blockMasterSubTenantMismatch = () => (
    truthy(process.env.FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH) && multiTenantMode()
);
const auditInTransactionEnabled = () => truthy(process.env.FINANCIAL_AUDIT_IN_TRANSACTION);
const redisFailClosed = () => truthy(process.env.FINANCIAL_REDIS_FAIL_CLOSED);

const codedError = (message, statusCode) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = message;
    error.publicMessage = PUBLIC_MESSAGES[message] || 'تعذر إتمام العملية المالية.';
    return error;
};

const idString = (value) => (value === null || value === undefined || value === '' ? null : String(value));

const defaultTenantId = () => idString(process.env.DEFAULT_TENANT_ID);

/** Missing tenantId on a legacy row is the single default organization, not a foreign one. */
const canonicalTenantId = (value) => idString(value) || defaultTenantId();

/**
 * Tenant comes only from the server resolver (req.tenant / req.tenantId).
 * Body, query, and client-supplied tenantId are ignored.
 */
const trustedRequestTenantId = (source) => {
    if (!source || typeof source !== 'object') return null;
    if (source._bsontype === 'ObjectId' || typeof source.toHexString === 'function') return source;
    return source.tenantId || (source.tenant && source.tenant._id) || null;
};

const resolveStampTenant = ({ req, account } = {}) => {
    const requestTenant = trustedRequestTenantId(req);
    const accountTenant = account && account.tenantId ? account.tenantId : null;
    if (!tenantGuardEnabled()) {
        if (requestTenant && accountTenant && idString(requestTenant) !== idString(accountTenant)) {
            return accountTenant;
        }
        return accountTenant || requestTenant || null;
    }
    const requestCanonical = canonicalTenantId(requestTenant);
    const accountCanonical = canonicalTenantId(accountTenant);
    if (!requestCanonical || !accountCanonical || requestCanonical !== accountCanonical) {
        throw codedError('TENANT_UNRESOLVED', 503);
    }
    return accountTenant || requestTenant || requestCanonical;
};

const assertAccountsSameTenant = (sourceTenant, targetTenant) => {
    if (!tenantGuardEnabled()) return;
    const sourceCanonical = canonicalTenantId(sourceTenant);
    const targetCanonical = canonicalTenantId(targetTenant);
    if (!sourceCanonical || !targetCanonical || sourceCanonical !== targetCanonical) {
        throw codedError('CROSS_TENANT_TRANSFER', 403);
    }
};

const assertMasterSubPolicy = (subAccount, master) => {
    if (!blockMasterSubTenantMismatch()) return;
    const subTenant = canonicalTenantId(subAccount && subAccount.tenantId);
    const masterTenant = canonicalTenantId(master && master.tenantId);
    if (subTenant && masterTenant && subTenant !== masterTenant) {
        throw codedError('MASTER_SUB_TENANT_MISMATCH', 403);
    }
};

const SENSITIVE_KEY = /password|passphrase|token|authorization|cookie|secret|otp|pin/i;

const canonicalPayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    return Object.keys(payload).sort().reduce((accumulator, key) => {
        if (SENSITIVE_KEY.test(key)) return accumulator;
        const value = payload[key];
        if (value === undefined) return accumulator;
        accumulator[key] = value;
        return accumulator;
    }, {});
};

const boundFingerprint = ({ accountId, tenantId, channel, payload }) => {
    const body = {
        accountId: idString(accountId),
        tenantId: tenantId ? idString(tenantId) : null,
        channel: String(channel || ''),
        payload: canonicalPayload(payload)
    };
    return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
};

const replayFromExisting = (existing, fingerprint) => {
    if (!existing) return null;
    if (existing.idempotencyFingerprint === fingerprint && existing.idempotencyResponse) {
        return existing.idempotencyResponse;
    }
    throw codedError('IDEMPOTENCY_CONFLICT', 409);
};

const beginIdempotentFinancialRequest = async ({
    key,
    accountId,
    tenantId,
    channel,
    payload,
    fingerprint: suppliedFingerprint = null
}) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
        if (idempotencyRequired()) throw codedError('IDEMPOTENCY_KEY_REQUIRED', 400);
        return {
            active: false,
            key: null,
            fingerprint: null,
            replay: null,
            release: async () => {}
        };
    }
    if (!idempotencyEnabled()) {
        return {
            active: false,
            key: null,
            fingerprint: null,
            replay: null,
            release: async () => {}
        };
    }
    if (!UUID_RE.test(normalizedKey)) throw codedError('IDEMPOTENCY_KEY_INVALID', 400);

    const fingerprint = suppliedFingerprint || boundFingerprint({ accountId, tenantId, channel, payload });
    const first = replayFromExisting(
        await Transaction.findOne({ idempotencyKey: normalizedKey }).lean(),
        fingerprint
    );
    if (first) {
        return { active: true, key: normalizedKey, fingerprint, replay: first, release: async () => {} };
    }

    let lock;
    try {
        lock = await acquireLock(`idemp:${normalizedKey}`, 20000, {
            retryCount: 200,
            retryDelay: 30,
            allowMemoryFallback: !redisFailClosed()
        });
    } catch (error) {
        if (redisFailClosed() && distributedStateRequired()) {
            const wrapped = codedError('REDIS_LOCK_FAILED', 503);
            wrapped.cause = error;
            throw wrapped;
        }
        throw error;
    }

    try {
        const second = replayFromExisting(
            await Transaction.findOne({ idempotencyKey: normalizedKey }).lean(),
            fingerprint
        );
        if (second) {
            await releaseLock(lock);
            return { active: true, key: normalizedKey, fingerprint, replay: second, release: async () => {} };
        }
        return {
            active: true,
            key: normalizedKey,
            fingerprint,
            replay: null,
            release: async () => releaseLock(lock)
        };
    } catch (error) {
        await releaseLock(lock);
        throw error;
    }
};

const acquireWalletLock = async (accountId) => {
    // Main did not lock the wallet on web or internal balance transfer.
    // Fail closed only when the operator turns the flag on after Redis is confirmed.
    if (!redisFailClosed() || !distributedStateRequired()) return { release: async () => {} };
    try {
        const lock = await acquireLock(`wallet:${idString(accountId)}`, 10000, { retryCount: 20, retryDelay: 50 });
        return { release: async () => releaseLock(lock) };
    } catch (error) {
        const wrapped = codedError('REDIS_LOCK_FAILED', 503);
        wrapped.cause = error;
        throw wrapped;
    }
};

const tenantStamp = (tenantId) => (tenantId ? { tenantId } : {});

module.exports = {
    PUBLIC_MESSAGES,
    tenantMode,
    multiTenantMode,
    tenantGuardEnabled,
    canonicalTenantId,
    defaultTenantId,
    idempotencyRequired,
    idempotencyEnabled,
    strictIdempotencyBinding,
    blockMasterSubTenantMismatch,
    auditInTransactionEnabled,
    redisFailClosed,
    codedError,
    trustedRequestTenantId,
    resolveStampTenant,
    assertAccountsSameTenant,
    assertMasterSubPolicy,
    boundFingerprint,
    beginIdempotentFinancialRequest,
    acquireWalletLock,
    tenantStamp,
    idString
};
