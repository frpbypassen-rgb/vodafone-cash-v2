'use strict';

const mongoose = require('mongoose');

const traceSchema = new mongoose.Schema({
    event: { type: String, required: true, trim: true, maxlength: 80 },
    actor: { type: String, trim: true, maxlength: 120, default: '' },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now }
}, { _id: false });

const pointOfSaleSettlementSchema = new mongoose.Schema({
    reference: { type: String, required: true, unique: true, index: true },
    ownerAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'PointOfSaleCustomer', required: true, index: true },
    externalCustomerId: { type: String, required: true, trim: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 0.001 },
    type: { type: String, enum: ['full', 'partial'], required: true },
    status: { type: String, enum: ['awaiting_external_confirmation', 'completed', 'cancelled', 'failed'], default: 'awaiting_external_confirmation', index: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 160 },
    idempotencyFingerprint: { type: String, required: true, trim: true, maxlength: 128 },
    externalReference: { type: String, trim: true, maxlength: 160, default: '' },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, default: null },
    reservedAfter: { type: Number, default: null },
    trace: { type: [traceSchema], default: [] }
}, { timestamps: true });

pointOfSaleSettlementSchema.index({ ownerAgentId: 1, idempotencyKey: 1 }, { unique: true });
pointOfSaleSettlementSchema.index({ ownerAgentId: 1, customerId: 1, createdAt: -1 });

module.exports = mongoose.model('PointOfSaleSettlement', pointOfSaleSettlementSchema);
