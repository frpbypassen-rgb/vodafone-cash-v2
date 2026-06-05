// models/Settlement.js
// ===============================================
// 💰 نموذج التسوية المحاسبية — Settlement
// ===============================================
const mongoose = require('mongoose');

const settlementSchema = new mongoose.Schema({
    // فترة التسوية
    period: {
        start: { type: Date, required: true },
        end: { type: Date, required: true }
    },

    // نوع التسوية
    type: {
        type: String,
        required: true,
        enum: ['daily', 'weekly', 'monthly', 'custom']
    },

    // الجهة المعنية
    entityType: {
        type: String,
        required: true,
        enum: ['executor', 'client_user', 'client_company', 'system']
    },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    entityName: { type: String },

    // ملخص مالي
    summary: {
        totalTransactions: { type: Number, default: 0 },
        totalAmountEGP: { type: Number, default: 0 },
        totalCostLYD: { type: Number, default: 0 },
        totalCommission: { type: Number, default: 0 },
        totalRefunds: { type: Number, default: 0 },
        netAmount: { type: Number, default: 0 },
        completedCount: { type: Number, default: 0 },
        cancelledCount: { type: Number, default: 0 },
        pendingCount: { type: Number, default: 0 }
    },

    // تفاصيل إضافية
    details: {
        openingBalance: { type: Number, default: 0 },
        closingBalance: { type: Number, default: 0 },
        deposits: { type: Number, default: 0 },
        deductions: { type: Number, default: 0 },
        transferTypes: { type: mongoose.Schema.Types.Mixed } // { vodafone: X, post_account: Y, ... }
    },

    // حالة التسوية
    status: {
        type: String,
        default: 'draft',
        enum: ['draft', 'pending_approval', 'approved', 'paid', 'disputed']
    },

    // الاعتماد
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    approvedByName: { type: String },
    approvedAt: { type: Date },
    paidAt: { type: Date },

    // ملاحظات
    notes: { type: String },
    disputeReason: { type: String },

    // Multi-tenant
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }

}, { timestamps: true });

// فهارس
settlementSchema.index({ 'period.start': 1, 'period.end': 1 });
settlementSchema.index({ entityType: 1, entityId: 1, 'period.start': -1 });
settlementSchema.index({ status: 1, createdAt: -1 });
settlementSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('Settlement', settlementSchema);
