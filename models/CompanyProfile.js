'use strict';

const mongoose = require('mongoose');

const companyProfileSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', required: true, unique: true },
    brandingName: { type: String, trim: true, default: '' },
    enabled: { type: Boolean, default: false },
    sharedDailyLimit: { type: Number, default: 0 },
    defaultEmployeeApprovalLimit: { type: Number, default: 0 },
    defaultManagerApprovalLimit: { type: Number, default: 0 },
    linkedUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ClientEmployee' }],
    settings: {
        requireWebAuthnForExecute: { type: Boolean, default: false },
        allowEmployeeDrafts: { type: Boolean, default: true },
        anomalyMultiplier: { type: Number, default: 3 }
    },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

companyProfileSchema.index({ companyId: 1, enabled: 1 });
companyProfileSchema.index({ tenantId: 1 });

module.exports = mongoose.models.CompanyProfile || mongoose.model('CompanyProfile', companyProfileSchema);
