'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'sending', 'sent', 'failed', 'uncertain'], default: 'pending' },
    messageId: String,
}, { timestamps: true });
module.exports = mongoose.models.TelegramReceiptClaim || mongoose.model('TelegramReceiptClaim', schema);
