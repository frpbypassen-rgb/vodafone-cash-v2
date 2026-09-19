'use strict';

const mongoose = require('mongoose');

const corporatePaymentRequestSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', required: true },
    reference: { type: String, required: true, unique: true, trim: true },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, default: 'EGP', trim: true },
    originalAmount: { type: Number },
    originalCurrency: { type: String, trim: true, default: 'EGP' },
    settledAmount: { type: Number },
    settledCurrency: { type: String, trim: true, default: 'LYD' },
    exchangeRate: { type: Number },
    beneficiaryId: { type: mongoose.Schema.Types.ObjectId, ref: 'CorporateBeneficiary', required: true },
    beneficiarySnapshot: {
        name: { type: String, trim: true, default: '' },
        serviceType: { type: String, trim: true, default: '' },
        accountNumberLast4: { type: String, trim: true, default: '' }
    },
    status: {
        type: String,
        enum: ['draft', 'pending_approval', 'approved', 'executing', 'execution_failed', 'rejected', 'executed'],
        default: 'draft',
        index: true
    },
    requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientEmployee', required: true },
    requesterName: { type: String, trim: true, default: '' },
    requesterRole: { type: String, enum: ['manager', 'employee', 'accountant'] },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientEmployee' },
    approverName: { type: String, trim: true, default: '' },
    approvedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, trim: true, maxlength: 500, default: '' },
    executedAt: { type: Date },
    executionAttemptedAt: { type: Date },
    executionError: { type: String, trim: true, default: '' },
    ledgerTransactionId: { type: String, trim: true, default: '' },
    payoutTransactionId: { type: String, trim: true, default: '' },
    idempotencyKey: { type: String, trim: true, unique: true, sparse: true },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    auditNotes: [{
        authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientEmployee' },
        authorName: { type: String, trim: true, default: '' },
        authorRole: { type: String, trim: true, default: '' },
        body: { type: String, trim: true, maxlength: 1000, required: true },
        createdAt: { type: Date, default: Date.now }
    }],
    reconciled: { type: Boolean, default: false },
    reconciledAt: { type: Date },
    reconciledById: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientEmployee' },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'CorporateInvoice' },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

corporatePaymentRequestSchema.index({ companyId: 1, status: 1, createdAt: -1 });
corporatePaymentRequestSchema.index({ companyId: 1, requesterId: 1, createdAt: -1 });
corporatePaymentRequestSchema.index({ companyId: 1, beneficiaryId: 1, createdAt: -1 });
corporatePaymentRequestSchema.index({ companyId: 1, payoutTransactionId: 1 });
corporatePaymentRequestSchema.index({ tenantId: 1, companyId: 1, createdAt: -1 });

module.exports = mongoose.models.CorporatePaymentRequest
    || mongoose.model('CorporatePaymentRequest', corporatePaymentRequestSchema);
