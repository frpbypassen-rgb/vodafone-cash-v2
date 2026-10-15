'use strict';

const mongoose = require('mongoose');

const merchantAccountSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    balance: { type: Number, default: 0 },
    officeId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialOffice', default: null },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

merchantAccountSchema.index({ tenantId: 1, status: 1, name: 1 });

module.exports = mongoose.models.MerchantAccount || mongoose.model('MerchantAccount', merchantAccountSchema);
