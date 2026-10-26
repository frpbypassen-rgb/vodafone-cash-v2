'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    actorModel: { type: String, enum: ['ClientEmployee'], required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId },
    email: { type: String, default: '' },
    verifiedAt: Date,
    enabled: { type: Boolean, default: false },
    pendingEmail: String,
    challengeId: String,
    challengeHash: { type: String, select: false },
    challengeExpiresAt: Date,
    challengeAttempts: { type: Number, default: 0 },
    requestAfter: { type: Date, default: () => new Date(0) },
    testAfter: { type: Date, default: () => new Date(0) },
    lastSentAt: Date,
    lastReportDay: String,
    lastDeliveryStatus: String,
}, { timestamps: true });
schema.index({ actorModel: 1, actorId: 1 }, { unique: true });
schema.index({ enabled: 1, _id: 1 });
module.exports = mongoose.models.CompanyReportEmail || mongoose.model('CompanyReportEmail', schema);
