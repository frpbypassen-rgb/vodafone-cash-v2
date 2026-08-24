'use strict';

const mongoose = require('mongoose');

// One web trust and one app trust may coexist. A new device replaces only the
// active trust in its own channel.
const trustedDeviceSchema = new mongoose.Schema({
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    accountType: { type: String, required: true, index: true },
    channel: { type: String, enum: ['web', 'app'], default: 'web', index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null },
    deviceIdHash: { type: String, required: true },
    sessionId: { type: String, default: null, index: true },
    deviceType: { type: String, default: 'هاتف' },
    userAgent: { type: String, default: '' },
    label: { type: String, default: '' },
    active: { type: Boolean, default: true, index: true },
    trustedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: '' }
}, { timestamps: true, versionKey: false });

trustedDeviceSchema.index({ accountId: 1, accountType: 1, channel: 1, active: 1 });
trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TrustedDevice', trustedDeviceSchema);
