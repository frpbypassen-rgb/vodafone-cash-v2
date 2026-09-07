'use strict';

const mongoose = require('mongoose');

const merchantWebhookSubscriptionSchema = new mongoose.Schema({
    // accountId/accountType isolate both companies and agencies. companyId is
    // retained for backward compatibility with the first webhook release.
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    accountType: { type: String, enum: ['company', 'agent'], required: true, index: true },
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    events: [{ type: String, enum: ['transaction.pending', 'transaction.processing', 'transaction.completed', 'transaction.failed'] }],
    status: { type: String, enum: ['active', 'paused', 'disabled'], default: 'active', index: true },
    // AES-GCM encrypted. The secret is shown only when the subscription is created or rotated.
    signingSecretEncrypted: { type: String, required: true, select: false },
    secretFingerprint: { type: String, required: true },
    lastDeliveredAt: { type: Date },
    lastFailureAt: { type: Date },
    failureCount: { type: Number, default: 0, min: 0 },
    createdBy: { type: String, trim: true, default: '' },
    rotatedAt: { type: Date }
}, { timestamps: true });

merchantWebhookSubscriptionSchema.index({ companyId: 1, status: 1 });
merchantWebhookSubscriptionSchema.index({ companyId: 1, url: 1 }, { unique: true });
merchantWebhookSubscriptionSchema.index({ accountId: 1, accountType: 1, url: 1 }, { unique: true });

module.exports = mongoose.model('MerchantWebhookSubscription', merchantWebhookSubscriptionSchema);
