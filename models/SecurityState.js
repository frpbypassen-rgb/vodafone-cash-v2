'use strict';

const mongoose = require('mongoose');

const securityStateSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, default: 'global' },
    adminDeviceEnforcementEnabled: { type: Boolean, default: true },
    accountDeviceEnforcementEnabled: { type: Boolean, default: true },
    // The following controls are deliberately opt-out rather than opt-in.  A
    // missing value on an older installation therefore receives the safer
    // behaviour when it is read by securityControlService.
    mandatoryAuthenticatorEnabled: { type: Boolean, default: true },
    adminApprovalRequired: { type: Boolean, default: true },
    singleDeviceOnly: { type: Boolean, default: true },
    adminPermissionEnforcementEnabled: { type: Boolean, default: false },
    locationRequired: { type: Boolean, default: true },
    highConfidenceVpnBlockEnabled: { type: Boolean, default: true },
    adminSessionHours: { type: Number, min: 1, max: 24, default: 12 },
    accountSessionHours: { type: Number, min: 1, max: 24, default: 12 },
    lockdownActive: { type: Boolean, default: false, index: true },
    lockdownStartedAt: { type: Date, default: null },
    lockdownEndsAt: { type: Date, default: null },
    lockdownReason: { type: String, maxlength: 500, default: '' },
    lockdownActivatedBy: { type: String, default: '' },
    emergencyCodeHash: { type: String, select: false, default: '' },
    emergencyCodeVersion: { type: Number, default: 0 },
    emergencyCodeRotatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: '' }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('SecurityState', securityStateSchema);
