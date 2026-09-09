'use strict';

const mongoose = require('mongoose');

const pointOfSaleCustomerSchema = new mongoose.Schema({
    ownerAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    receiptPhone: { type: String, trim: true, maxlength: 30, default: '' },
    balance: { type: Number, default: 0, min: 0 },
    reservedBalance: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    externalLink: {
        externalCustomerId: { type: String, trim: true, maxlength: 120, default: '' },
        externalCustomerName: { type: String, trim: true, maxlength: 120, default: '' },
        linkedAt: { type: Date, default: null },
        linkedBy: { type: String, trim: true, maxlength: 120, default: '' }
    }
}, { timestamps: true });

pointOfSaleCustomerSchema.index({ ownerAgentId: 1, phone: 1 });
pointOfSaleCustomerSchema.index({ ownerAgentId: 1, 'externalLink.externalCustomerId': 1 });

module.exports = mongoose.model('PointOfSaleCustomer', pointOfSaleCustomerSchema);
