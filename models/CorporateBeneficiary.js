'use strict';

const mongoose = require('mongoose');
const { encrypt, decrypt, isEncrypted } = require('../utils/encryption');

const corporateBeneficiarySchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    serviceType: {
        type: String,
        enum: ['vodafone', 'post_account', 'post_card', 'bank_account', 'sefa_niger', 'bankak_sudan'],
        default: 'vodafone'
    },
    accountNumberEncrypted: { type: String, required: true, select: false },
    accountNumberLast4: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['approved', 'disabled'], default: 'approved' },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientEmployee' },
    createdByName: { type: String, trim: true, default: '' },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

corporateBeneficiarySchema.index({ companyId: 1, status: 1, createdAt: -1 });
corporateBeneficiarySchema.index({ companyId: 1, name: 1 });
corporateBeneficiarySchema.index({ tenantId: 1, companyId: 1 });

corporateBeneficiarySchema.statics.encryptAccountNumber = function encryptAccountNumber(value) {
    const raw = String(value || '').replace(/\s+/g, '');
    if (!raw) throw new Error('ACCOUNT_NUMBER_REQUIRED');
    return {
        accountNumberEncrypted: encrypt(raw),
        accountNumberLast4: raw.slice(-4)
    };
};

corporateBeneficiarySchema.methods.decryptAccountNumber = function decryptAccountNumber() {
    const stored = this.accountNumberEncrypted;
    if (!stored) return '';
    return isEncrypted(stored) ? decrypt(stored) : stored;
};

corporateBeneficiarySchema.methods.toPublicJSON = function toPublicJSON(options = {}) {
    const includeFull = options.includeFullAccount === true;
    return {
        id: String(this._id),
        companyId: String(this.companyId),
        name: this.name,
        serviceType: this.serviceType,
        accountNumberLast4: this.accountNumberLast4,
        accountNumber: includeFull ? this.decryptAccountNumber() : undefined,
        status: this.status,
        notes: this.notes,
        createdByName: this.createdByName,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.models.CorporateBeneficiary
    || mongoose.model('CorporateBeneficiary', corporateBeneficiarySchema);
