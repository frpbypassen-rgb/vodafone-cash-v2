'use strict';

const mongoose = require('mongoose');

const opsInternalNoteSchema = new mongoose.Schema({
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    authorId: { type: String, default: '' },
    authorName: { type: String, required: true, trim: true, maxlength: 120 },
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

opsInternalNoteSchema.index({ transactionId: 1, createdAt: -1 }, { name: 'opsNote_tx_createdAt' });
opsInternalNoteSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'opsNote_tenant_createdAt' });

module.exports = mongoose.model('OpsInternalNote', opsInternalNoteSchema);
