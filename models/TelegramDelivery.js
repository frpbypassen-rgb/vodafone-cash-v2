'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
    reference: { type: String, trim: true, index: true },
    chatId: { type: String, trim: true, index: true },
    status: { type: String, enum: ['sending', 'sent', 'failed', 'skipped'], default: 'sending', index: true },
    messageId: { type: String, default: '' },
    failureCode: { type: String, default: '' },
    failureReason: { type: String, default: '' },
    receiptUrl: { type: String, default: '' },
    receiptIdentity: { type: String, default: '' },
    sentAt: { type: Date }
}, { timestamps: true });
schema.index({ transactionId: 1, chatId: 1 }, { unique: true });
module.exports = mongoose.models.TelegramDelivery || mongoose.model('TelegramDelivery', schema);
