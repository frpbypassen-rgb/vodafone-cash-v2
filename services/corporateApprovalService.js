'use strict';

const CorporateBeneficiary = require('../models/CorporateBeneficiary');
const CorporatePaymentRequest = require('../models/CorporatePaymentRequest');
const { logAction } = require('./auditService');
const { executeCompanyDebit, buildReference, findExistingLedger } = require('./corporateLedgerService');
const { resolveCorporateRole, resolveApprovalLimit } = require('./corporateRoleService');

class CorporateError extends Error {
    constructor(code, message, statusCode = 400) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

const loadApprovedBeneficiary = async (companyId, beneficiaryId) => {
    const beneficiary = await CorporateBeneficiary.findOne({
        _id: beneficiaryId,
        companyId,
        status: 'approved'
    }).select('+accountNumberEncrypted');
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
        currency: plain.currency || 'EGP',
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
        ledgerTransactionId: plain.ledgerTransactionId || '',
        notes: plain.notes || '',
        auditNotes: plain.auditNotes || [],
        reconciled: Boolean(plain.reconciled),
        createdAt: plain.createdAt,
        updatedAt: plain.updatedAt
    };
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
                    status: { $in: ['pending_approval', 'approved', 'executed'] }
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
    const reference = payload.reference || buildReference();
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
        reference,
        amount,
        currency: payload.currency || 'EGP',
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
        metadata: { companyId: String(companyId), reference, amount, status: requestedStatus },
        result: requestedStatus === 'pending_approval' ? 'معلق' : 'ناجح'
    });

    if (requestedStatus === 'approved') {
        return executeRequest({ context, request, req, autoApproved: true });
    }

    return { request: toPublicRequest(request), created: true };
};

const executeRequest = async ({ context, request, req, autoApproved = false }) => {
    if (request.status === 'executed' && request.ledgerTransactionId) {
        return { request: toPublicRequest(request), created: false, executed: true, idempotent: true };
    }
    if (!['approved', 'pending_approval'].includes(request.status) && request.status !== 'executed') {
        throw new CorporateError('INVALID_STATUS', 'لا يمكن تنفيذ هذا الطلب في حالته الحالية.', 409);
    }

    if (request.status === 'executed') {
        return { request: toPublicRequest(request), created: false, executed: true, idempotent: true };
    }

    const existingLedger = await findExistingLedger(request.reference);
    if (existingLedger) {
        request.status = 'executed';
        request.ledgerTransactionId = request.reference;
        request.executedAt = request.executedAt || new Date();
        if (autoApproved && !request.approverId) {
            request.approverId = context.actor._id;
            request.approverName = context.actor.name;
            request.approvedAt = request.approvedAt || new Date();
        }
        await request.save();
        return { request: toPublicRequest(request), created: false, executed: true, idempotent: true };
    }

    const debit = await executeCompanyDebit({
        company: context.company,
        amount: request.amount,
        reference: request.reference,
        description: `تحويل شركات إلى ${request.beneficiarySnapshot?.name || 'مستفيد'} (${request.reference})`,
        tenantId: context.tenantId,
        minBalance: -(Number(context.company.creditLimit) || 0)
    });

    request.status = 'executed';
    request.ledgerTransactionId = debit.transactionId;
    request.executedAt = new Date();
    if (autoApproved && !request.approverId) {
        request.approverId = context.actor._id;
        request.approverName = context.actor.name;
        request.approvedAt = new Date();
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
            ledgerTransactionId: debit.transactionId,
            idempotent: debit.idempotent
        }
    });

    context.company.balance = debit.balanceAfter;
    return { request: toPublicRequest(request), created: false, executed: true, idempotent: debit.idempotent };
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
    if (request.status !== 'pending_approval') {
        throw new CorporateError('INVALID_STATUS', 'هذا الطلب ليس معلقاً للاعتماد.', 409);
    }
    if (String(request.requesterId) === String(actor._id) && decision === 'approve') {
        throw new CorporateError('SELF_APPROVE', 'لا يمكن للمدير اعتماد طلبه عندما يتجاوز حدّه. اطلب مديراً آخر.', 403);
    }

    if (decision === 'reject') {
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

    request.status = 'approved';
    request.approverId = actor._id;
    request.approverName = actor.name;
    request.approvedAt = new Date();
    await request.save();
    await logAction({
        action: 'CORPORATE_TRANSFER_APPROVED',
        req,
        performedById: actor._id,
        performedByModel: 'ClientEmployee',
        performedByName: actor.name,
        targetId: request._id,
        targetModel: 'CorporatePaymentRequest',
        companyId,
        metadata: { companyId: String(companyId), reference: request.reference, role }
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
    loadApprovedBeneficiary,
    needsManagerApproval,
    toPublicRequest,
    createRequest,
    executeRequest,
    decideRequest,
    addAuditNote,
    reconcileRequest
};
