'use strict';

const mongoose = require('mongoose');

const merchantWebhookEndpointSchema = new mongoose.Schema({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
    ownerModel: { type: String, enum: ['ClientCompany', 'User'], required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, trim: true, maxlength: 100, default: 'Webhook' },
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    secretEncrypted: { type: String, required: true, select: false },
    secretHint: { type: String, default: '' },
    events: [{ type: String, enum: ['transfer.created', 'transfer.completed', 'transfer.cancelled'] }],
    enabled: { type: Boolean, default: true, index: true },
    failureCount: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    lastError: { type: String, maxlength: 500, default: '' },
    createdBy: { type: String, maxlength: 120, default: '' }
}, { timestamps: true });

merchantWebhookEndpointSchema.index({ tenantId: 1, ownerModel: 1, ownerId: 1, createdAt: -1 });
merchantWebhookEndpointSchema.index({ enabled: 1, events: 1 });

module.exports = mongoose.models.MerchantWebhookEndpoint
    || mongoose.model('MerchantWebhookEndpoint', merchantWebhookEndpointSchema);
