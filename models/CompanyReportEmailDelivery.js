'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    day: { type: String, required: true },
    kind: { type: String, enum: ['daily', 'test'], required: true },
    status: { type: String, enum: ['pending', 'processing', 'sent', 'failed', 'uncertain', 'cancelled'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    lockedAt: Date,
    retryAt: { type: Date, default: () => new Date(0) },
    sentAt: Date,
    errorCode: String,
}, { timestamps: true });
schema.index({ status: 1, retryAt: 1 });
module.exports = mongoose.models.CompanyReportEmailDelivery || mongoose.model('CompanyReportEmailDelivery', schema);
