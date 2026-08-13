'use strict';

const mongoose = require('mongoose');

const whatsAppDeliverySchema = new mongoose.Schema({
    kind: { type: String, enum: ['otp', 'receipt'], required: true, index: true },
    provider: { type: String, default: 'whatchimp' },
    recipientPhone: { type: String, required: true, index: true },
    recipientName: { type: String, default: '' },
    recipientModel: { type: String, default: '' },
    recipientId: { type: mongoose.Schema.Types.Mixed },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', index: true },
    reference: { type: String, default: '', index: true },
    templateName: { type: String, default: '' },
    templateId: { type: String, default: '' },
    messageId: { type: String, default: '', index: true },
    status: {
        type: String,
        enum: ['pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped'],
        default: 'pending',
        index: true
    },
    failureCode: { type: String, default: '' },
    failureReason: { type: String, default: '' },
    sentAt: { type: Date },
    stages: [{
        key: { type: String, trim: true },
        label: { type: String, trim: true },
        status: { type: String, enum: ['waiting', 'active', 'success', 'failed', 'skipped'], default: 'waiting' },
        detail: { type: String, default: '' },
        occurredAt: { type: Date, default: Date.now }
    }],
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, versionKey: false });

whatsAppDeliverySchema.index(
    { kind: 1, transactionId: 1, recipientPhone: 1 },
    {
        unique: true,
        partialFilterExpression: { kind: 'receipt', transactionId: { $exists: true } },
        name: 'whatsapp_receipt_once_per_recipient'
    }
);
whatsAppDeliverySchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('WhatsAppDelivery', whatsAppDeliverySchema);
