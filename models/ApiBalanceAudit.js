'use strict';

const mongoose = require('mongoose');

const balanceSnapshotSchema = new mongoose.Schema({
    success: { type: Boolean, default: false },
    serviceCredit: { type: Number, default: null },
    cashCredit: { type: Number, default: null },
    availableBalance: { type: Number, default: null },
    message: { type: String, default: '' },
    checkedAt: { type: Date, default: Date.now }
}, { _id: false });

const apiBalanceAuditSchema = new mongoose.Schema({
    executorGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', required: true, index: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, index: true },
    transactionCustomId: { type: String, required: true, index: true },
    providerTransactionId: { type: String, default: '' },
    referenceNumber: { type: String, default: '' },
    beforeCheck: { type: balanceSnapshotSchema, default: () => ({}) },
    afterCheck: { type: balanceSnapshotSchema, default: () => ({}) },
    previousAuditId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiBalanceAudit', default: null },
    previousPostAvailableBalance: { type: Number, default: null },
    continuityDifference: { type: Number, default: null },
    expectedDebit: { type: Number, default: null },
    observedDebit: { type: Number, default: null },
    debitDifference: { type: Number, default: null },
    executionStatus: {
        type: String,
        enum: ['started', 'success', 'pending', 'failed', 'error'],
        default: 'started'
    },
    checkStatus: {
        type: String,
        enum: ['pending', 'matched', 'discrepancy', 'check_failed'],
        default: 'pending',
        index: true
    },
    hasDiscrepancy: { type: Boolean, default: false, index: true },
    alerts: [{ type: String }],
    reviewStatus: {
        type: String,
        enum: ['not_required', 'pending', 'reviewed'],
        default: 'not_required',
        index: true
    },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: '' },
    reviewNotes: { type: String, default: '' },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null }
}, { timestamps: true });

apiBalanceAuditSchema.index({ executorGroupId: 1, createdAt: -1 });
apiBalanceAuditSchema.index({ executorGroupId: 1, hasDiscrepancy: 1, createdAt: -1 });

module.exports = mongoose.model('ApiBalanceAudit', apiBalanceAuditSchema);
