// models/Reconciliation.js
// ===============================================
// 🔄 نموذج المطابقة — Reconciliation
// ===============================================
const mongoose = require('mongoose');

const reconciliationSchema = new mongoose.Schema({
    // تاريخ المطابقة
    reconciliationDate: { type: Date, required: true },

    // نوع المطابقة
    type: {
        type: String,
        required: true,
        enum: ['daily', 'weekly', 'monthly', 'manual']
    },

    // النتائج
    status: {
        type: String,
        default: 'pending',
        enum: ['pending', 'matched', 'discrepancy_found', 'resolved']
    },

    // ملخص المطابقة
    summary: {
        totalEntitiesChecked: { type: Number, default: 0 },
        matchedCount: { type: Number, default: 0 },
        discrepancyCount: { type: Number, default: 0 },
        totalLedgerSum: { type: Number, default: 0 },
        totalAccountBalance: { type: Number, default: 0 },
        difference: { type: Number, default: 0 }
    },

    // تفاصيل الفروقات
    discrepancies: [{
        entityType: { type: String, enum: ['User', 'ClientBot', 'ExecutorBot', 'SubAccount'] },
        entityId: { type: mongoose.Schema.Types.ObjectId },
        entityName: { type: String },
        accountBalance: { type: Number },     // الرصيد في حساب الكيان
        ledgerBalance: { type: Number },      // الرصيد المحسوب من الدفتر
        difference: { type: Number },         // الفرق
        possibleCause: { type: String },      // السبب المحتمل
        resolved: { type: Boolean, default: false },
        resolvedBy: { type: String },
        resolvedAt: { type: Date },
        resolutionNotes: { type: String }
    }],

    // فحوصات إضافية
    checks: {
        ledgerIntegrity: { type: Boolean, default: false },         // هل كل عملية لها قيد؟
        balanceConsistency: { type: Boolean, default: false },      // هل الأرصدة متطابقة؟
        transactionStatusConsistency: { type: Boolean, default: false }, // هل الحالات منطقية؟
        orphanedTransactions: { type: Number, default: 0 },         // عمليات بدون قيد
        orphanedLedgerEntries: { type: Number, default: 0 }         // قيود بدون عملية
    },

    // من أجرى المطابقة
    performedBy: { type: String, default: 'System' },

    // Multi-tenant
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },

    // ملاحظات
    notes: { type: String }

}, { timestamps: true });

// فهارس
reconciliationSchema.index({ reconciliationDate: -1 });
reconciliationSchema.index({ status: 1, reconciliationDate: -1 });
reconciliationSchema.index({ tenantId: 1, reconciliationDate: -1 });

module.exports = mongoose.model('Reconciliation', reconciliationSchema);
