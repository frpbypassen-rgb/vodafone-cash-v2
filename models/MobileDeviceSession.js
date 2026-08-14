'use strict';

const mongoose = require('mongoose');

const mobileDeviceSessionSchema = new mongoose.Schema({
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    accountType: { type: String, enum: ['client_user', 'sub_client'], required: true },
    sessionId: { type: String, required: true, unique: true, index: true },
    refreshTokenHash: { type: String, required: true },
    deviceFingerprint: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    deviceType: { type: String, default: 'هاتف' },
    active: { type: Boolean, default: true, index: true },
    lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true, versionKey: false });

mobileDeviceSessionSchema.index({ accountId: 1, accountType: 1, active: 1, lastSeenAt: -1 });

module.exports = mongoose.model('MobileDeviceSession', mobileDeviceSessionSchema);
