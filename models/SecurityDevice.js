'use strict';

const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    accuracy: { type: Number, min: 0 },
    capturedAt: { type: Date, default: null }
}, { _id: false });

const securityDeviceSchema = new mongoose.Schema({
    principalType: {
        type: String,
        required: true,
        enum: ['master_admin', 'admin', 'executor', 'client_user', 'client_company', 'agent_staff', 'sub_client'],
        index: true
    },
    principalId: { type: String, required: true, index: true },
    channel: { type: String, required: true, enum: ['web', 'app'], default: 'web', index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    displayName: { type: String, trim: true, maxlength: 120, default: 'جهاز موثوق' },
    deviceIdHash: { type: String, required: true, index: true, select: false },
    credentialId: { type: String, default: null, sparse: true, index: true },
    credentialPublicKey: { type: Buffer, default: null, select: false },
    credentialCounter: { type: Number, default: 0 },
    credentialTransports: { type: [String], default: [] },
    credentialDeviceType: { type: String, default: '' },
    credentialBackedUp: { type: Boolean, default: false },
    platform: { type: String, trim: true, maxlength: 80, default: '' },
    browser: { type: String, trim: true, maxlength: 80, default: '' },
    deviceType: { type: String, enum: ['computer', 'phone', 'tablet', 'unknown'], default: 'unknown' },
    userAgent: { type: String, maxlength: 1000, default: '' },
    firstIp: { type: String, maxlength: 100, default: '' },
    lastIp: { type: String, maxlength: 100, default: '' },
    firstLocation: { type: locationSchema, default: null },
    lastLocation: { type: locationSchema, default: null },
    status: { type: String, enum: ['pending', 'active', 'revoked'], default: 'pending', index: true },
    approvedBy: { type: String, default: '' },
    approvedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, maxlength: 300, default: '' },
    lastSeenAt: { type: Date, default: null },
    lastVerifiedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

securityDeviceSchema.index(
    { principalType: 1, principalId: 1, channel: 1, status: 1 },
    {
        name: 'uniq_active_security_device_per_channel',
        unique: true,
        partialFilterExpression: { status: 'active' }
    }
);

module.exports = mongoose.model('SecurityDevice', securityDeviceSchema);
