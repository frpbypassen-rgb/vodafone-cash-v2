'use strict';
const TERMINAL = new Set(['completed', 'rejected', 'cancelled_by_admin']);
const hasReference = (data) =>
    Boolean(
        data.referenceNumber ||
        data.externalTransactionId ||
        data.providerTransactionId ||
        data.providerReportedReference
    );
const hasClaim = (data) => Boolean(data.providerDispatchAttemptId || data.providerDispatchStartedAt);
const pristine = (tx) => {
    const data = tx.apiResultData || {};
    if (typeof data !== 'object' || Array.isArray(data)) return false;
    return (
        tx.status === 'processing' &&
        !tx.completedAt &&
        Boolean(tx.executorGroupId) &&
        !hasClaim(data) &&
        !hasReference(data) &&
        !data.providerDispatchResult &&
        data.providerResultUnresolved !== true &&
        data.ledgerPosted !== true &&
        !data.runtimeRecoveryFence &&
        !data.providerResolutionOutcome &&
        !data.providerResolvedAt &&
        data.waitingApiAutoCompletion !== true
    );
};
const summarize = (tx) => {
    const data = tx.apiResultData || {};
    return {
        transaction: tx.customId,
        status: tx.status,
        terminal: TERMINAL.has(tx.status),
        claim: hasClaim(data),
        reference: hasReference(data),
        result: data.providerDispatchResult || null,
        ledgerPosted: data.ledgerPosted ?? null,
    };
};

// The same durable field used by Payment claims is reserved atomically. Either
// Payment wins and recovery stops, or recovery wins and no old worker can pay.
const buildRecoveryFence = (tx, token, now = new Date()) => {
    if (!pristine(tx)) throw new Error('TARGET_NOT_PRISTINE');
    const existed = Object.prototype.hasOwnProperty.call(tx, 'apiResultData');
    const original = tx.apiResultData;
    const fenced = {
        ...(original || {}),
        providerDispatchAttemptId: token,
        providerDispatchStartedAt: now,
        providerResultUnresolved: true,
        providerResultUnresolvedReason: 'Operational recovery fence; recovery has NOT sent a Payment request',
        runtimeRecoveryFence: token,
    };
    const identity = { _id: tx._id, status: 'processing', executorGroupId: tx.executorGroupId };
    if (tx.updatedAt) identity.updatedAt = tx.updatedAt;
    return {
        filter: { ...identity, apiResultData: existed ? original : { $exists: false } },
        update: { $set: { apiResultData: fenced } },
        releaseFilter: { ...identity, apiResultData: fenced },
        releaseUpdate: existed ? { $set: { apiResultData: original } } : { $unset: { apiResultData: '' } },
    };
};

module.exports = { TERMINAL, pristine, summarize, buildRecoveryFence };
