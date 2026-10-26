'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    tenantId: mongoose.Schema.Types.ObjectId,
    name: { type: String, required: true, maxlength: 60 },
    chatId: String,
    username: String,
    telegramName: String,
    enabled: { type: Boolean, default: false },
    linkedAt: Date,
    lastInteractionAt: Date,
    deletedAt: { type: Date, default: null },
    codeHash: { type: String, select: false },
    codeExpiresAt: Date,
    requestedById: { type: mongoose.Schema.Types.ObjectId, required: true },
    requestedByModel: { type: String, enum: ['ClientEmployee'], required: true },
}, { timestamps: true });
schema.index({ companyId: 1, tenantId: 1, deletedAt: 1 });
schema.index({ codeHash: 1 }, { unique: true, sparse: true });
schema.index({ companyId: 1, chatId: 1 }, { unique: true, partialFilterExpression: { chatId: { $type: 'string' }, deletedAt: null } });
module.exports = mongoose.models.CompanyTelegramConnection || mongoose.model('CompanyTelegramConnection', schema);
