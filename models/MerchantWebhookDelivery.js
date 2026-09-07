'use strict';

const mongoose = require('mongoose');

const merchantWebhookDeliverySchema = new mongoose.Schema({
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'MerchantWebhookSubscription', required: true, index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', required: true, index: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, index: true },
    eventType: { type: String, required: true },
    eventId: { type: String, required: true, unique: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['pending', 'sending', 'delivered', 'failed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    deliveredAt: { type: Date },
    lastAttemptAt: { type: Date },
    lastResponseCode: { type: Number },
    lastError: { type: String, maxlength: 500 }
}, { timestamps: true });

merchantWebhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
merchantWebhookDeliverySchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('MerchantWebhookDelivery', merchantWebhookDeliverySchema);
