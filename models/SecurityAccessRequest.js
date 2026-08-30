'use strict';

const mongoose = require('mongoose');

const securityAccessRequestSchema = new mongoose.Schema({
    requestCode: { type: String, required: true, unique: true, index: true },
    principalType: { type: String, required: true, index: true },
    principalId: { type: String, required: true, index: true },
    principalName: { type: String, maxlength: 160, default: '' },
    channel: { type: String, required: true, enum: ['web', 'app'], default: 'web', index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    deviceIdHash: { type: String, required: true, select: false },
    displayName: { type: String, maxlength: 120, default: 'جهاز جديد' },
    deviceType: { type: String, enum: ['computer', 'phone', 'tablet', 'unknown'], default: 'unknown' },
    platform: { type: String, maxlength: 80, default: '' },
    browser: { type: String, maxlength: 80, default: '' },
    userAgent: { type: String, maxlength: 1000, default: '' },
    ipAddress: { type: String, maxlength: 100, default: '' },
    countryCode: { type: String, maxlength: 8, default: '' },
    location: {
        latitude: { type: Number, min: -90, max: 90 },
        longitude: { type: Number, min: -180, max: 180 },
        accuracy: { type: Number, min: 0 },
        capturedAt: { type: Date, default: null }
    },
    riskSignals: { type: [String], default: [] },
    // A new device is never silently approved.  For a device transfer this
    // records that the owner proved possession of the Authenticator first.
    purpose: { type: String, enum: ['first_login', 'device_transfer'], default: 'first_login' },
    authenticatorVerifiedAt: { type: Date, default: null },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'expired'], default: 'pending', index: true },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, maxlength: 500, default: '' },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { timestamps: true, versionKey: false });

securityAccessRequestSchema.index({ principalType: 1, principalId: 1, channel: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('SecurityAccessRequest', securityAccessRequestSchema);
