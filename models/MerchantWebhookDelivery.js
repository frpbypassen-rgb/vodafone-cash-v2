'use strict';

const mongoose = require('mongoose');

const merchantWebhookDeliverySchema = new mongoose.Schema({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
    endpointId: { type: mongoose.Schema.Types.ObjectId, ref: 'MerchantWebhookEndpoint', required: true, index: true },
    ownerModel: { type: String, enum: ['ClientCompany', 'User'], required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    eventId: { type: String, required: true, maxlength: 180 },
    eventType: { type: String, required: true, enum: ['transfer.created', 'transfer.completed', 'transfer.cancelled'], index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['pending', 'sending', 'delivered', 'failed'], default: 'pending', index: true },
    attemptCount: { type: Number, default: 0 },
    responseCode: { type: Number, default: null },
    responsePreview: { type: String, maxlength: 500, default: '' },
    lastError: { type: String, maxlength: 500, default: '' },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lastAttemptAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null }
}, { timestamps: true });

merchantWebhookDeliverySchema.index({ endpointId: 1, eventId: 1 }, { unique: true });
merchantWebhookDeliverySchema.index({ status: 1, nextAttemptAt: 1, lockedAt: 1 });
merchantWebhookDeliverySchema.index({ tenantId: 1, ownerModel: 1, ownerId: 1, createdAt: -1 });

module.exports = mongoose.models.MerchantWebhookDelivery
    || mongoose.model('MerchantWebhookDelivery', merchantWebhookDeliverySchema);
