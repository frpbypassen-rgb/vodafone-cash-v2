'use strict';

const mongoose = require('mongoose');

// Kept in a dedicated collection so every account model can use the same
// transfer-PIN policy without storing a sensitive hash in many schemas.
const operationPinProfileSchema = new mongoose.Schema({
    principalType: {
        type: String,
        required: true,
        enum: ['master_admin', 'admin', 'executor', 'client_user', 'client_company', 'agent_staff', 'sub_client'],
        index: true
    },
    principalId: { type: String, required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    pinHash: { type: String, required: true, select: false },
    enabled: { type: Boolean, default: true },
    createdBy: { type: String, default: '' },
    lastChangedBy: { type: String, default: '' },
    lastChangedAt: { type: Date, default: null },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

operationPinProfileSchema.index({ principalType: 1, principalId: 1 }, { unique: true });

module.exports = mongoose.model('OperationPinProfile', operationPinProfileSchema);
