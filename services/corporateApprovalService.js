'use strict';

const CorporateBeneficiary = require('../models/CorporateBeneficiary');
const CorporatePaymentRequest = require('../models/CorporatePaymentRequest');
const { logAction } = require('./auditService');
const { executeCompanyPayout, buildReference, CorporateLedgerError } = require('./corporateLedgerService');
const { resolveCorporateRole, resolveApprovalLimit } = require('./corporateRoleService');

class CorporateError extends Error {
    constructor(code, message, statusCode = 400) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

const RETRYABLE_STATUSES = Object.freeze(['pending_approval', 'approved', 'execution_failed']);
const TERMINAL_EXECUTED = 'executed';

const wrapLedgerError = (error) => {
    if (error instanceof CorporateError) return error;
    if (error instanceof CorporateLedgerError) {
        return new CorporateError(error.code, error.message, error.statusCode || 400);
    }
    return new CorporateError(error.code || 'PAYOUT_FAILED', error.message || 'تعذر تنفيذ التحويل.', error.statusCode || 500);
};

const loadApprovedBeneficiary = async (companyId, beneficiaryId) => {
    const query = CorporateBeneficiary.findOne({
        _id: beneficiaryId,
        companyId,
        status: 'approved'
    });
    const beneficiary = query && typeof query.select === 'function'
        ? await query.select('+accountNumberEncrypted')
        : await query;
    if (!beneficiary) throw new CorporateError('BENEFICIARY_NOT_ALLOWED', 'المستفيد غير معتمد أو لا يخص هذه الشركة.', 403);
    return beneficiary;
};

const needsManagerApproval = ({ amount, actor, profile }) => {
    const role = resolveCorporateRole(actor);
    if (role === 'accountant') return true;
    const limit = resolveApprovalLimit(actor, profile || {});
    return Number(amount) > Number(limit || 0);
};

const toPublicRequest = (doc) => {
    const plain = doc.toObject ? doc.toObject() : { ...doc };
    return {
        id: String(plain._id),
        companyId: String(plain.companyId),
        reference: plain.reference,
        amount: plain.amount,
        currency: plain.currency || plain.originalCurrency || 'EGP',
        originalAmount: plain.originalAmount != null ? plain.originalAmount : plain.amount,
        originalCurrency: plain.originalCurrency || plain.currency || 'EGP',
        settledAmount: plain.settledAmount != null ? plain.settledAmount : null,
        settledCurrency: plain.settledCurrency || 'LYD',
        exchangeRate: plain.exchangeRate != null ? plain.exchangeRate : null,
        beneficiaryId: String(plain.beneficiaryId),
        beneficiary: plain.beneficiarySnapshot || {},
        status: plain.status,
        requesterId: String(plain.requesterId),
        requesterName: plain.requesterName,
        requesterRole: plain.requesterRole,
        approverId: plain.approverId ? String(plain.approverId) : null,
        approverName: plain.approverName || '',
        approvedAt: plain.approvedAt || null,
        rejectedAt: plain.rejectedAt || null,
        rejectionReason: plain.rejectionReason || '',
        executedAt: plain.executedAt || null,
        executionError: plain.executionError || '',
        ledgerTransactionId: plain.ledgerTransactionId || '',
        payoutTransactionId: plain.payoutTransactionId || '',
        notes: plain.notes || '',
        auditNotes: plain.auditNotes || [],
        reconciled: Boolean(plain.reconciled),
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt
    };
};

const applySettlement = (request, payout) => {
    const quote = payout.quote || {};
    request.originalAmount = quote.originalAmount != null ? quote.originalAmount : request.amount;
    request.originalCurrency = quote.originalCurrency || request.currency || 'EGP';
    request.settledAmount = payout.costLYD != null ? payout.costLYD : quote.settledAmount;
    request.settledCurrency = quote.settledCurrency || 'LYD';
    request.exchangeRate = payout.exchangeRate != null ? payout.exchangeRate : quote.exchangeRate;
    request.payoutTransactionId = payout.txId;
    request.ledgerTransactionId = payout.txId;
    request.executionError = '';
};

const markExecutionFailed = async (request, error) => {
    request.status = 'execution_failed';
    request.executionError = String(error.message || error.code || 'PAYOUT_FAILED').slice(0, 500);
    await request.save();
    return request;
};

const claimForExecution = async ({ requestId, companyId, actor, fromStatuses = RETRYABLE_STATUSES }) => {
    const current = await CorporatePaymentRequest.findOne({ _id: requestId, companyId });
    if (!current) throw new CorporateError('NOT_FOUND', 'الطلب غير موجود.', 404);

    if (current.status === TERMINAL_EXECUTED && current.payoutTransactionId) {
        return { request: current, idempotent: true };
    }

    const claimed = await CorporatePaymentRequest.findOneAndUpdate(
        {
            _id: requestId,
            companyId,
            status: { $in: fromStatuses },
            $or: [
                { payoutTransactionId: { $exists: false } },
                { payoutTransactionId: null },
                { payoutTransactionId: '' }
            ]
        },
        {
            $set: {
                status: 'executing',
                executionAttemptedAt: new Date(),
                executionError: '',
                ...(actor ? {
                    approverId: current.approverId || actor._id,
                    approverName: current.approverName || actor.name,
                    approvedAt: current.approvedAt || new Date()
                } : {})
            }
        },
        { new: true }
    );

    if (claimed) return { request: claimed, idempotent: false };

    const again = await CorporatePaymentRequest.findOne({ _id: requestId, companyId });
    if (again?.status === TERMINAL_EXECUTED && again.payoutTransactionId) {
        return { request: again, idempotent: true };
    }
    if (again?.status === 'executing') {
        throw new CorporateError('IN_FLIGHT', 'التنفيذ جارٍ بالفعل. أعد المحاولة بعد لحظات.', 409);
    }
    throw new CorporateError('INVALID_STATUS', 'لا يمكن تنفيذ هذا الطلب في حالته الحالية.', 409);
};

const executeClaimedRequest = async ({ context, request, req, autoApproved = false }) => {
    if (request.status === TERMINAL_EXECUTED && request.payoutTransactionId) {
        return { request: toPublicRequest(request), created: false, executed: true, idempotent: true };
    }

    let beneficiary;
    try {
        beneficiary = await loadApprovedBeneficiary(context.companyId, request.beneficiaryId);
        const payout = await executeCompanyPayout({ context, request, beneficiary, req });
        applySettlement(request, payout);
        request.status = TERMINAL_EXECUTED;
        request.executedAt = request.executedAt || new Date();
        if (autoApproved && !request.approverId) {
            request.approverId = context.actor._id;
            request.approverName = context.actor.name;
            request.approvedAt = request.approvedAt || new Date();
        }
        await request.save();

        await logAction({
            action: 'CORPORATE_TRANSFER_EXECUTED',
            req,
            performedById: context.actor._id,
            performedByModel: 'ClientEmployee',
            performedByName: context.actor.name,
            targetId: request._id,
            targetModel: 'CorporatePaymentRequest',
            companyId: context.companyId,
            metadata: {
                companyId: String(context.companyId),
                reference: request.reference,
                ledgerTransactionId: request.ledgerTransactionId,
                payoutTransactionId: request.payoutTransactionId,
                originalAmount: request.originalAmount,
                originalCurrency: request.originalCurrency,
                settledAmount: request.settledAmount,
                settledCurrency: request.settledCurrency,
                exchangeRate: request.exchangeRate,
                idempotent: payout.idempotent
            }
        });

        if (payout.newBalance != null) context.company.balance = payout.newBalance;
        return {
            request: toPublicRequest(request),
            created: false,
            executed: true,
            idempotent: payout.idempotent
        };
    } catch (error) {
        await markExecutionFailed(request, error);
        throw wrapLedgerError(error);
    }
};

const executeRequest = async ({ context, request, req, autoApproved = false }) => {
    if (request.status === TERMINAL_EXECUTED && request.payoutTransactionId) {
        return { request: toPublicRequest(request), created: false, executed: true, idempotent: true };
    }

    const fromStatuses = request.status === 'executing' ? ['executing', ...RETRYABLE_STATUSES] : RETRYABLE_STATUSES;
    const claimed = await claimForExecution({
        requestId: request._id,
        companyId: context.companyId,
        actor: context.actor,
        fromStatuses
    });
    if (claimed.idempotent) {
        return { request: toPublicRequest(claimed.request), created: false, executed: true, idempotent: true };
    }
    return executeClaimedRequest({ context, request: claimed.request, req, autoApproved });
};

const retryExecution = async ({ context, requestId, req }) => {
    const request = await CorporatePaymentRequest.findOne({ _id: requestId, companyId: context.companyId });
    if (!request) throw new CorporateError('NOT_FOUND', 'الطلب غير موجود.', 404);
    const isRequester = String(request.requesterId) === String(context.actor._id);
    if (!context.permissions.canApprove && !isRequester) {
        throw new CorporateError('CORPORATE_FORBIDDEN', 'إعادة التنفيذ متاحة لمقدم الطلب أو المدير.', 403);
    }
    if (!RETRYABLE_STATUSES.includes(request.status) && request.status !== TERMINAL_EXECUTED) {
        throw new CorporateError('INVALID_STATUS', 'لا يمكن إعادة تنفيذ هذا الطلب في حالته الحالية.', 409);
    }
    return executeRequest({ context, request, req, autoApproved: isRequester && !context.permissions.canApprove });
};

const createRequest = async ({ context, payload, req }) => {
    const { actor, company, profile, role, permissions, companyId, tenantId } = context;
    if (!permissions.canTransfer) {
        throw new CorporateError('CORPORATE_FORBIDDEN', 'هذا الدور لا ينشئ تحويلات.', 403);
    }

    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new CorporateError('INVALID_AMOUNT', 'أدخل مبلغاً صحيحاً.');
    }

    const dailyLimit = Number(profile?.sharedDailyLimit || company.corporatePortal?.sharedDailyLimit || 0);
    if (dailyLimit > 0) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const spent = await CorporatePaymentRequest.aggregate([
            {
                $match: {
                    companyId,
                    createdAt: { $gte: start },
                    status: { $in: ['pending_approval', 'approved', 'executing', 'executed'] }
                }
            },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        const used = Number(spent[0]?.total || 0);
        if (used + amount > dailyLimit) {
            throw new CorporateError('DAILY_LIMIT', 'تجاوز الحد اليومي المشترك للشركة.');
        }
    }

    const beneficiary = await loadApprovedBeneficiary(companyId, payload.beneficiaryId);
    const pending = needsManagerApproval({ amount, actor, profile: profile || company.corporatePortal });
    const requestedStatus = payload.status === 'draft' ? 'draft' : (pending ? 'pending_approval' : 'approved');

    if (payload.idempotencyKey) {
        const existing = await CorporatePaymentRequest.findOne({
            companyId,
            idempotencyKey: String(payload.idempotencyKey)
        });
        if (existing) return { request: toPublicRequest(existing), created: false };
    }

    const request = await CorporatePaymentRequest.create({
        companyId,
        tenantId,
        reference: buildReference(),
        amount,
        currency: payload.currency || 'EGP',
        originalAmount: amount,
        originalCurrency: payload.currency || 'EGP',
        settledCurrency: 'LYD',
        beneficiaryId: beneficiary._id,
        beneficiarySnapshot: {
            name: beneficiary.name,
            serviceType: beneficiary.serviceType,
            accountNumberLast4: beneficiary.accountNumberLast4
        },
        status: requestedStatus,
        requesterId: actor._id,
        requesterName: actor.name,
        requesterRole: role,
        notes: String(payload.notes || '').trim().slice(0, 500),
        idempotencyKey: payload.idempotencyKey ? String(payload.idempotencyKey) : undefined
    });

    await logAction({
        action: requestedStatus === 'pending_approval' ? 'CORPORATE_TRANSFER_PENDING' : 'CORPORATE_TRANSFER_CREATED',
        req,
        performedById: actor._id,
        performedByModel: 'ClientEmployee',
        performedByName: actor.name,
        targetId: request._id,
        targetModel: 'CorporatePaymentRequest',
        companyId,
        metadata: { companyId: String(companyId), reference: request.reference, amount, status: requestedStatus },
        result: requestedStatus === 'pending_approval' ? 'معلق' : 'ناجح'
    });

    if (requestedStatus === 'approved') {
        return executeRequest({ context, request, req, autoApproved: true });
    }

    return { request: toPublicRequest(request), created: true };
};

const decideRequest = async ({ context, requestId, decision, reason, req }) => {
    const { actor, companyId, role, permissions } = context;
    if (decision === 'approve' && !permissions.canApprove) {
        throw new CorporateError('CORPORATE_FORBIDDEN', 'اعتماد التحويلات متاح للمدير فقط.', 403);
    }
    if (decision === 'reject' && !permissions.canReject) {
        throw new CorporateError('CORPORATE_FORBIDDEN', 'رفض التحويلات متاح للمدير فقط.', 403);
    }

    const request = await CorporatePaymentRequest.findOne({ _id: requestId, companyId });
    if (!request) throw new CorporateError('NOT_FOUND', 'الطلب غير موجود.', 404);

    if (decision === 'reject') {
        if (request.status !== 'pending_approval') {
            throw new CorporateError('INVALID_STATUS', 'هذا الطلب ليس معلقاً للاعتماد.', 409);
        }
        request.status = 'rejected';
        request.rejectedAt = new Date();
        request.rejectionReason = String(reason || '').trim().slice(0, 500);
        request.approverId = actor._id;
        request.approverName = actor.name;
        await request.save();
        await logAction({
            action: 'CORPORATE_TRANSFER_REJECTED',
            req,
            performedById: actor._id,
            performedByModel: 'ClientEmployee',
            performedByName: actor.name,
            targetId: request._id,
            targetModel: 'CorporatePaymentRequest',
            companyId,
            metadata: { companyId: String(companyId), reference: request.reference, reason: request.rejectionReason }
        });
        return { request: toPublicRequest(request) };
    }

    if (request.status === TERMINAL_EXECUTED && request.payoutTransactionId) {
        return { request: toPublicRequest(request), executed: true, idempotent: true };
    }
    if (!RETRYABLE_STATUSES.includes(request.status)) {
        throw new CorporateError('INVALID_STATUS', 'هذا الطلب ليس معلقاً للاعتماد أو قابلاً لإعادة التنفيذ.', 409);
    }
    if (String(request.requesterId) === String(actor._id) && request.status === 'pending_approval') {
        throw new CorporateError('SELF_APPROVE', 'لا يمكن للمدير اعتماد طلبه عندما يتجاوز حدّه. اطلب مديراً آخر.', 403);
    }

    await logAction({
        action: 'CORPORATE_TRANSFER_APPROVED',
        req,
        performedById: actor._id,
        performedByModel: 'ClientEmployee',
        performedByName: actor.name,
        targetId: request._id,
        targetModel: 'CorporatePaymentRequest',
        companyId,
        metadata: { companyId: String(companyId), reference: request.reference, role, fromStatus: request.status }
    });

    return executeRequest({ context, request, req });
};

const addAuditNote = async ({ context, requestId, body, req }) => {
    if (!context.permissions.canAnnotate) {
        throw new CorporateError('CORPORATE_FORBIDDEN', 'إضافة ملاحظات التدقيق غير متاحة لدورك.', 403);
    }
    const text = String(body || '').trim();
    if (!text) throw new CorporateError('INVALID_NOTE', 'أدخل نص الملاحظة.');
    const request = await CorporatePaymentRequest.findOne({ _id: requestId, companyId: context.companyId });
    if (!request) throw new CorporateError('NOT_FOUND', 'الطلب غير موجود.', 404);
    request.auditNotes.push({
        authorId: context.actor._id,
        authorName: context.actor.name,
        authorRole: context.role,
        body: text.slice(0, 1000),
        createdAt: new Date()
    });
    await request.save();
    await logAction({
        action: 'CORPORATE_AUDIT_NOTE',
        req,
        performedById: context.actor._id,
        performedByModel: 'ClientEmployee',
        performedByName: context.actor.name,
        targetId: request._id,
        targetModel: 'CorporatePaymentRequest',
        companyId: context.companyId,
        metadata: { companyId: String(context.companyId), reference: request.reference }
    });
    return { request: toPublicRequest(request) };
};

const reconcileRequest = async ({ context, requestId, req }) => {
    if (!context.permissions.canReconcile) {
        throw new CorporateError('CORPORATE_FORBIDDEN', 'المطابقة متاحة للمحاسب فقط.', 403);
    }
    const request = await CorporatePaymentRequest.findOne({ _id: requestId, companyId: context.companyId });
    if (!request) throw new CorporateError('NOT_FOUND', 'الطلب غير موجود.', 404);
    request.reconciled = true;
    request.reconciledAt = new Date();
    request.reconciledById = context.actor._id;
    await request.save();
    await logAction({
        action: 'CORPORATE_RECONCILED',
        req,
        performedById: context.actor._id,
        performedByModel: 'ClientEmployee',
        performedByName: context.actor.name,
        targetId: request._id,
        targetModel: 'CorporatePaymentRequest',
        companyId: context.companyId,
        metadata: { companyId: String(context.companyId), reference: request.reference }
    });
    return { request: toPublicRequest(request) };
};

module.exports = {
    CorporateError,
    RETRYABLE_STATUSES,
    loadApprovedBeneficiary,
    needsManagerApproval,
    toPublicRequest,
    createRequest,
    executeRequest,
    retryExecution,
    decideRequest,
    addAuditNote,
    reconcileRequest
};
