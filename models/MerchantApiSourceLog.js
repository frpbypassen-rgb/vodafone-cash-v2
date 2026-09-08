'use strict';

const mongoose = require('mongoose');

// Immutable, metadata-only audit trail for requests received from a company's
// Merchant API source. Request bodies and API keys are never persisted here.
const merchantApiSourceLogSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', required: true, index: true },
    serverId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    sourceIp: { type: String, required: true, trim: true, index: true },
    deviceLabel: { type: String, trim: true, maxlength: 180, default: '' },
    userAgent: { type: String, trim: true, maxlength: 1000, default: '' },
    method: { type: String, trim: true, maxlength: 12, default: 'GET' },
    endpoint: { type: String, trim: true, maxlength: 180, default: '' },
    statusCode: { type: Number, min: 0, default: 0 },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    transactionReference: { type: String, trim: true, maxlength: 80, default: '' }
}, { timestamps: true });

merchantApiSourceLogSchema.index({ companyId: 1, sourceIp: 1, createdAt: -1 });
merchantApiSourceLogSchema.index({ companyId: 1, serverId: 1, createdAt: -1 });

module.exports = mongoose.model('MerchantApiSourceLog', merchantApiSourceLogSchema);
