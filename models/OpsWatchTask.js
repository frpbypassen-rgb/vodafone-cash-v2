'use strict';

const mongoose = require('mongoose');

const COLOR_PALETTE = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0ea5e9'];

const hashColor = (value) => {
    const text = String(value || '');
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(index);
        hash |= 0;
    }
    return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
};

const opsWatchTaskSchema = new mongoose.Schema({
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
    reason: { type: String, trim: true, maxlength: 300, default: 'مراجعة تشغيلية' },
    assigneeId: { type: String, default: '' },
    assigneeName: { type: String, required: true, trim: true, maxlength: 120 },
    assigneeColor: { type: String, default: '#2563eb' },
    createdById: { type: String, default: '' },
    createdByName: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
    resolvedByName: { type: String, default: '' }
}, { timestamps: true, versionKey: false });

opsWatchTaskSchema.index({ transactionId: 1, status: 1, createdAt: -1 }, { name: 'opsTask_tx_status_createdAt' });
opsWatchTaskSchema.index({ tenantId: 1, status: 1, createdAt: -1 }, { name: 'opsTask_tenant_status_createdAt' });

opsWatchTaskSchema.statics.colorFor = hashColor;

module.exports = mongoose.model('OpsWatchTask', opsWatchTaskSchema);
