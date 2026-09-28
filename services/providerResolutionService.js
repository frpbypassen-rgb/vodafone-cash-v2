'use strict';

const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Ledger = require('../models/Ledger');
const { logAction } = require('./auditService');
const eventBus = require('./eventBus');
const queueService = require('./queueService');
const { completeApiTransactionWithReference } = require('./apiExecutionLifecycleService');
const {
    UNRESOLVED_CODE,
    providerMoneyHold,
    clearClaimOnDoc
} = require('./providerDispatchClaimService');

const PROVIDER_RESOLUTION_PERMISSION = 'transactions.resolve_provider';
const EXECUTOR_DEBIT_DESCRIPTION = 'تنفيذ API آلي';
const NOT_PAID_CONFLICT_CODE = 'NOT_PAID_CONFLICTS_WITH_EVIDENCE';
const OUTCOMES = new Set(['provider_paid', 'provider_not_paid']);

const actorCanResolve = (actor) => {
    if (!actor) return false;
    if (String(actor.role || '') === 'master') return true;
    const permissions = new Set(actor.permissions || []);
    return permissions.has('*') || permissions.has(PROVIDER_RESOLUTION_PERMISSION);
};

const clean = (value) => String(value || '').trim();

const resolutionOutcomeOf = (tx) => clean(tx && tx.apiResultData && tx.apiResultData.providerResolutionOutcome);

const sameInstant = (left, right) => {
    const leftMs = new Date(left).getTime();
    const rightMs = new Date(right).getTime();
    return Number.isFinite(leftMs) && leftMs === rightMs;
};

const executorDebitQuery = (tx, executorGroupId) => ({
    entityModel: 'ExecutorGroup',
    entityId: executorGroupId,
    transactionId: tx.customId,
    type: 'TRANSFER',
    amount: -Number(tx.amount || 0),
    description: EXECUTOR_DEBIT_DESCRIPTION
});

const countExecutorDebits = async (tx) => {
    if (!tx || !tx.executorGroupId || !tx.customId) return 0;
    return Ledger.countDocuments(executorDebitQuery(tx, tx.executorGroupId));
};

const storedProviderReference = (tx) => {
    const data = (tx && tx.apiResultData) || {};
    return [
        data.referenceNumber,
        data.externalTransactionId,
        data.providerTransactionId,
        data.providerTransactionNumber,
        data.transactionNumber
    ].map(clean).find(Boolean) || '';
};

const notPaidEvidenceConflict = async (tx) => {
    if (!tx) return null;
    const data = tx.apiResultData || {};
    if (data.providerResolutionEffectStartedAt) return 'providerResolutionEffectStartedAt';
    const dispatchResult = clean(data.providerDispatchResult);
    if (dispatchResult === 'pending_reference' || dispatchResult === 'accepted') return dispatchResult;
    const reference = storedProviderReference(tx);
    if (reference) return 'provider_reference';
    if (data.waitingApiAutoCompletion === true && clean(data.referenceNumber)) return 'waiting_reference';
    if (tx.customId) {
        const debit = await Ledger.findOne({
            entityModel: 'ExecutorGroup',
            transactionId: tx.customId,
            type: 'TRANSFER',
            amount: { $lt: 0 }
        }).select('_id').lean();
        if (debit) return 'executor_debit';
    }
    return null;
};

const notPaidConflictResponse = (tx, reason) => ({
    success: false,
    statusCode: 409,
    code: NOT_PAID_CONFLICT_CODE,
    reason,
    transactionId: tx && tx._id ? String(tx._id) : null,
    customId: tx ? tx.customId : null,
    message: 'لا يمكن اعتماد عدم الدفع: يوجد أثر مالي أو إثبات من المزود. لن يتغير شيء ولن تعود العملية قابلة للإرسال.'
});

const moneyPreview = async (tx, outcome) => {
    const debits = await countExecutorDebits(tx);
    if (outcome === 'provider_paid') {
        return {
            statusAfter: 'completed',
            executorGroupIdAfter: tx.executorGroupId ? String(tx.executorGroupId) : null,
            providerPaymentCalls: 0,
            customerRefundLYD: 0,
            customerCreditLYD: 0,
            moneyMovements: [{
                entityModel: 'ExecutorGroup',
                entityId: tx.executorGroupId ? String(tx.executorGroupId) : null,
                amount: -Number(tx.amount || 0),
                type: 'TRANSFER',
                description: EXECUTOR_DEBIT_DESCRIPTION,
                apply: debits === 0
            }]
        };
    }
    return {
        statusAfter: 'pending',
        executorGroupIdAfter: null,
        providerPaymentCalls: 0,
        customerRefundLYD: 0,
        customerCreditLYD: 0,
        follows: 'releaseFailedApiExecutionToPending',
        moneyMovements: []
    };
};

const snapshot = (tx) => ({
    status: tx.status,
    executorGroupId: tx.executorGroupId ? String(tx.executorGroupId) : null,
    providerDispatchResult: tx.apiResultData && tx.apiResultData.providerDispatchResult || null,
    providerResultUnresolved: tx.apiResultData && tx.apiResultData.providerResultUnresolved === true,
    providerResolutionOutcome: resolutionOutcomeOf(tx) || null,
    updatedAt: tx.updatedAt
});

const effectDone = (tx, outcome) => {
    if (resolutionOutcomeOf(tx) !== outcome) return false;
    if (outcome === 'provider_paid') return tx.status === 'completed';
    return tx.status === 'pending' && tx.apiResultData && tx.apiResultData.providerResultUnresolved !== true;
};

const validateRequest = (input) => {
    const outcome = clean(input.outcome);
    const evidenceReference = clean(input.evidenceReference);
    const note = clean(input.note);
    if (!OUTCOMES.has(outcome)) {
        return { error: { success: false, statusCode: 400, code: 'OUTCOME_INVALID', message: 'ناتج الحسم يجب أن يكون provider_paid أو provider_not_paid.' } };
    }
    if (!evidenceReference || !note) {
        return { error: { success: false, statusCode: 400, code: 'EVIDENCE_REQUIRED', message: 'حسم النتيجة يتطلب مرجع إثبات من المزود وملاحظة نصية. لن يُنفَّذ شيء بدونها.' } };
    }
    return { outcome, evidenceReference, note };
};

const resolveProviderResult = async (input = {}) => {
    if (!actorCanResolve(input.actor)) {
        return {
            success: false,
            statusCode: 403,
            code: 'PROVIDER_RESOLUTION_FORBIDDEN',
            message: 'هذه العملية تتطلب صلاحية transactions.resolve_provider.'
        };
    }

    const validated = validateRequest(input);
    if (validated.error) return validated.error;
    const { outcome, evidenceReference, note } = validated;

    const tx = await Transaction.findById(input.transactionId);
    if (!tx) {
        return { success: false, statusCode: 404, code: 'NOT_FOUND', message: 'العملية غير موجودة.' };
    }

    if (effectDone(tx, outcome) && resolutionOutcomeOf(tx) === outcome && clean(tx.apiResultData && tx.apiResultData.providerResolutionEvidence) === evidenceReference) {
        const preview = await moneyPreview(tx, outcome);
        return {
            success: true,
            idempotent: true,
            applied: false,
            statusCode: 200,
            code: 'ALREADY_RESOLVED',
            transactionId: String(tx._id),
            customId: tx.customId,
            outcome,
            preview
        };
    }

    if (outcome === 'provider_not_paid') {
        const conflict = await notPaidEvidenceConflict(tx);
        if (conflict) return notPaidConflictResponse(tx, conflict);
    }

    if (!providerMoneyHold(tx) || resolutionOutcomeOf(tx)) {
        return {
            success: false,
            statusCode: 409,
            code: resolutionOutcomeOf(tx) ? 'RESOLUTION_IN_PROGRESS' : 'NOT_ELIGIBLE',
            message: resolutionOutcomeOf(tx)
                ? 'حسم هذه العملية قيد التنفيذ. لا تُعاد الحركة المالية.'
                : 'هذه العملية ليست معلّقة على نتيجة مزود غير محسومة.'
        };
    }

    const preview = await moneyPreview(tx, outcome);
    const before = snapshot(tx);
    const responseBase = {
        success: true,
        transactionId: String(tx._id),
        customId: tx.customId,
        outcome,
        evidenceReference,
        note,
        expectedUpdatedAt: tx.updatedAt,
        before,
        preview,
        code: UNRESOLVED_CODE
    };

    if (input.confirm !== true) {
        return { ...responseBase, dryRun: true, applied: false, statusCode: 200 };
    }

    if (!input.expectedUpdatedAt || !sameInstant(input.expectedUpdatedAt, tx.updatedAt)) {
        return {
            success: false,
            statusCode: 409,
            code: 'ROW_CHANGED',
            message: 'تغيّرت العملية بعد المعاينة. أعد المعاينة ثم أكّد نفس المرجع والملاحظة.'
        };
    }

    if (outcome === 'provider_paid' && !tx.executorGroupId) {
        return {
            success: false,
            statusCode: 409,
            code: 'EXECUTOR_MISSING',
            message: 'لا يمكن اعتماد الدفع: المنفذ المعيّن غير موجود على العملية.'
        };
    }

    const claim = await Transaction.collection.findOneAndUpdate(
        {
            _id: tx._id,
            updatedAt: tx.updatedAt,
            status: tx.status,
            'apiResultData.providerResolutionOutcome': { $exists: false },
            $or: [
                { 'apiResultData.providerResultUnresolved': true },
                { 'apiResultData.providerDispatchResult': 'pending_reference' }
            ]
        },
        {
            $set: {
                'apiResultData.providerResolutionOutcome': outcome,
                'apiResultData.providerResolutionEvidence': evidenceReference,
                'apiResultData.providerResolutionNote': note,
                'apiResultData.providerResolutionActorId': String(input.actor.id || ''),
                'apiResultData.providerResolutionClaimedAt': new Date(),
                updatedAt: new Date()
            }
        },
        { returnDocument: 'after' }
    );
    const claimed = claim && (Object.prototype.hasOwnProperty.call(claim, 'value') ? claim.value : claim);
    if (!claimed) {
        const latest = await Transaction.findById(tx._id);
        if (latest && effectDone(latest, outcome)) {
            return {
                success: true,
                idempotent: true,
                applied: false,
                statusCode: 200,
                code: 'ALREADY_RESOLVED',
                transactionId: String(latest._id),
                customId: latest.customId,
                outcome,
                preview: await moneyPreview(latest, outcome)
            };
        }
        return {
            success: false,
            statusCode: 409,
            code: 'ROW_CHANGED',
            message: 'تغيّرت العملية أثناء التأكيد. لم تُنفَّذ حركة مالية.'
        };
    }

    const effect = await Transaction.collection.updateOne(
        {
            _id: tx._id,
            'apiResultData.providerResolutionOutcome': outcome,
            'apiResultData.providerResolutionEvidence': evidenceReference,
            'apiResultData.providerResolutionEffectStartedAt': { $exists: false }
        },
        { $set: { 'apiResultData.providerResolutionEffectStartedAt': new Date(), updatedAt: new Date() } }
    );
    if (!effect || effect.modifiedCount !== 1) {
        return {
            success: false,
            statusCode: 409,
            code: 'RESOLUTION_IN_PROGRESS',
            message: 'حسم هذه العملية قيد التنفيذ. لا تُعاد الحركة المالية.'
        };
    }

    const current = await Transaction.findById(tx._id);
    let statusAfter = current.status;
    if (outcome === 'provider_paid') {
        const executorGroup = await ExecutorGroup.findById(current.executorGroupId);
        if (!executorGroup) {
            return { success: false, statusCode: 409, code: 'EXECUTOR_MISSING', message: 'المنفذ المعيّن لم يعد موجوداً.' };
        }
        const completion = await completeApiTransactionWithReference({
            tx: current,
            executorGroup,
            apiResult: {
                reference_number: evidenceReference,
                external_transaction_id: evidenceReference,
                provider_transaction_id: evidenceReference
            },
            receiptProof: null,
            detailedLog: null
        });
        if (!completion) {
            return { success: false, statusCode: 409, code: 'COMPLETION_REJECTED', message: 'مسار الاعتماد الحالي رفض الإثبات.' };
        }
        current.apiResultData = {
            ...(current.apiResultData || {}),
            providerResolutionOutcome: outcome,
            providerResolutionEvidence: evidenceReference,
            providerResolutionNote: note,
            providerResolutionActorId: String(input.actor.id || ''),
            providerResolvedAt: new Date()
        };
        if (typeof current.markModified === 'function') current.markModified('apiResultData');
        await current.save();
        eventBus.publish('transfer:completed', {
            tx: current,
            emp: { name: executorGroup.name || 'تنفيذ آلي (API)' }
        });
        statusAfter = current.status;
    } else {
        current.apiResultData = {
            ...(current.apiResultData || {}),
            providerResultUnresolved: false,
            providerDispatchResult: 'rejected',
            providerResolutionOutcome: outcome,
            providerResolutionEvidence: evidenceReference,
            providerResolutionNote: note,
            providerResolutionActorId: String(input.actor.id || ''),
            providerResolvedAt: new Date()
        };
        clearClaimOnDoc(current);
        current.apiResultData = {
            ...(current.apiResultData || {}),
            providerDispatchResult: 'rejected',
            providerResultUnresolved: false,
            providerResolutionOutcome: outcome,
            providerResolutionEvidence: evidenceReference,
            providerResolutionNote: note,
            providerResolutionActorId: String(input.actor.id || ''),
            providerResolvedAt: new Date()
        };
        if (typeof current.markModified === 'function') current.markModified('apiResultData');
        await queueService.releaseFailedApiExecutionToPending(current, {
            failureNote: `[PROVIDER_NOT_PAID] إثبات المزود: ${evidenceReference}. ${note}`
        });
        statusAfter = 'pending';
    }

    const afterTx = await Transaction.findById(tx._id);
    await logAction({
        action: 'PROVIDER_RESULT_RESOLVED',
        req: input.req,
        performedById: input.actor.id,
        performedByModel: 'Admin',
        performedByName: input.actor.name || 'Admin',
        targetId: tx._id,
        targetModel: 'Transaction',
        oldData: before,
        newData: snapshot(afterTx),
        metadata: {
            outcome,
            evidenceReference,
            note,
            moneyMovements: preview.moneyMovements,
            providerPaymentCalls: 0
        },
        severity: 'critical',
        required: true,
        success: true
    });

    return {
        ...responseBase,
        dryRun: false,
        applied: true,
        idempotent: false,
        statusCode: 200,
        code: 'PROVIDER_RESULT_RESOLVED',
        statusAfter,
        after: snapshot(afterTx)
    };
};

module.exports = {
    PROVIDER_RESOLUTION_PERMISSION,
    NOT_PAID_CONFLICT_CODE,
    actorCanResolve,
    resolveProviderResult
};
