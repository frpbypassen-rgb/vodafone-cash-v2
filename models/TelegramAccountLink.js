'use strict';

const mongoose = require('mongoose');

const telegramAccountLinkSchema = new mongoose.Schema({
    ownerModel: { type: String, enum: ['User', 'ClientCompany', 'SubAccount'], required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
    codeHash: { type: String, required: true, unique: true, index: true, select: false },
    codeHint: { type: String, required: true, select: false },
    chatId: { type: String, trim: true, default: '', index: true },
    linkedAt: { type: Date, default: null },
    linkedBy: { type: String, default: 'telegram' },
    deliveryMode: { type: String, enum: ['off', 'whatsapp', 'telegram', 'both'], default: 'whatsapp' },
    active: { type: Boolean, default: true, index: true }
}, { timestamps: true });

telegramAccountLinkSchema.index({ ownerModel: 1, ownerId: 1 });
telegramAccountLinkSchema.index({ chatId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.TelegramAccountLink
    || mongoose.model('TelegramAccountLink', telegramAccountLinkSchema);
