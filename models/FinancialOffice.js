'use strict';

const mongoose = require('mongoose');

const financialOfficeSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

financialOfficeSchema.index({ tenantId: 1, name: 1 });

module.exports = mongoose.models.FinancialOffice || mongoose.model('FinancialOffice', financialOfficeSchema);
