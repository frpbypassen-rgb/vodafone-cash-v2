'use strict';

const mongoose = require('mongoose');

const corporateInvoiceSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientCompany', required: true },
    originalName: { type: String, trim: true, default: '' },
    storedName: { type: String, required: true, trim: true },
    mimeType: { type: String, trim: true, default: '' },
    size: { type: Number, default: 0 },
    vendorName: { type: String, trim: true, default: '' },
    amount: { type: Number, default: null },
    invoiceDate: { type: Date },
    uploadedById: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientEmployee' },
    uploadedByName: { type: String, trim: true, default: '' },
    matchStatus: { type: String, enum: ['unmatched', 'suggested', 'matched', 'duplicate'], default: 'unmatched' },
    matchedRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'CorporatePaymentRequest' },
    matchNotes: { type: String, trim: true, default: '' },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

corporateInvoiceSchema.index({ companyId: 1, createdAt: -1 });
corporateInvoiceSchema.index({ companyId: 1, matchStatus: 1, createdAt: -1 });

module.exports = mongoose.models.CorporateInvoice
    || mongoose.model('CorporateInvoice', corporateInvoiceSchema);
