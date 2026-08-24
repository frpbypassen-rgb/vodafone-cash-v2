'use strict';

const mongoose = require('mongoose');

const unifiedReportEntrySchema = new mongoose.Schema({
    transactionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Transaction',
        required: true,
        unique: true
    },
    customId: { type: String, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
    userId: { type: String, default: null },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', default: null },
    subAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubAccount', default: null },
    isSubAccountTx: { type: Boolean, default: false },
    companyName: { type: String, default: null },
    employeeName: { type: String, default: null },
    executorGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', default: null },
    managerGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecutorGroup', default: null },
    operatorId: { type: String, default: null },
    executorName: { type: String, default: null },
    status: { type: String, required: true },
    transferType: { type: String, default: null },
    createdAt: { type: Date, required: true },
    sourceUpdatedAt: { type: Date, required: true },
    indexedAt: { type: Date, default: Date.now },
    snapshotVersion: { type: Number, default: 1 },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true }
}, {
    collection: 'unified_report_entries',
    timestamps: false,
    minimize: false
});

unifiedReportEntrySchema.index({ tenantId: 1, createdAt: -1 });
unifiedReportEntrySchema.index({ userId: 1, createdAt: -1 });
unifiedReportEntrySchema.index({ companyId: 1, createdAt: -1 });
unifiedReportEntrySchema.index({ subAccountId: 1, createdAt: -1 });
unifiedReportEntrySchema.index({ executorGroupId: 1, createdAt: -1 });
unifiedReportEntrySchema.index({ managerGroupId: 1, createdAt: -1 });
unifiedReportEntrySchema.index({ operatorId: 1, createdAt: -1 });
unifiedReportEntrySchema.index({ status: 1, createdAt: -1 });
unifiedReportEntrySchema.index({ customId: 1 }, { unique: true });

module.exports = mongoose.model('UnifiedReportEntry', unifiedReportEntrySchema);
