'use strict';

const mongoose = require('mongoose');

const apiProviderReturnSchema = new mongoose.Schema({
    executorGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', required: true, index: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null, index: true },
    transactionCustomId: { type: String, default: '', index: true },
    providerTransactionId: { type: String, required: true },
    referenceNumber: { type: String, default: '' },
    providerStatus: { type: String, default: '' },
    amount: { type: Number, default: null },
    phone: { type: String, default: '' },
    serviceName: { type: String, default: '' },
    providerDate: { type: String, default: '' },
    providerTime: { type: String, default: '' },
    rawData: { type: Object, default: null },
    status: {
        type: String,
        enum: ['pending_review', 'cancelled', 'reviewed'],
        default: 'pending_review',
        index: true
    },
    firstDetectedAt: { type: Date, default: Date.now },
    lastCheckedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: '' },
    reviewNotes: { type: String, default: '' },
    cancellationNumber: { type: String, default: '' },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null }
}, { timestamps: true });

apiProviderReturnSchema.index(
    { executorGroupId: 1, providerTransactionId: 1 },
    { unique: true }
);
apiProviderReturnSchema.index({ executorGroupId: 1, status: 1, firstDetectedAt: -1 });

module.exports = mongoose.model('ApiProviderReturn', apiProviderReturnSchema);
