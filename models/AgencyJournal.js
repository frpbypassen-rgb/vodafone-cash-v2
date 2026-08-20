'use strict';

const mongoose = require('mongoose');
const { installAppendOnlyGuards } = require('../utils/financialRecordImmutability');

const journalLineSchema = new mongoose.Schema({
    accountCode: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
    side: { type: String, required: true, enum: ['debit', 'credit'] },
    amount: { type: Number, required: true, min: 0 },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    entityModel: { type: String, trim: true }
}, { _id: false });

const agencyJournalSchema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true, trim: true },
    ownerType: { type: String, required: true, enum: ['agent', 'company'] },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubAccount', index: true },
    transactionId: { type: String, required: true, trim: true, index: true },
    eventType: {
        type: String,
        required: true,
        enum: [
            'TRANSFER_RESERVED',
            'TRANSFER_REALIZED',
            'TRANSFER_REVERSED',
            'TRANSFER_REPRICED',
            'CUSTOMER_PAYMENT',
            'CUSTOMER_PAYOUT',
            'DEBT_PAYMENT',
            'BALANCE_CREDIT',
            'BALANCE_DEBIT'
        ]
    },
    status: { type: String, enum: ['reserved', 'posted', 'reversed'], default: 'posted' },
    currency: { type: String, default: 'LYD', enum: ['LYD'] },
    idempotencyKey: { type: String, trim: true },
    pricing: {
        serviceKey: { type: String, trim: true },
        amountEGP: { type: Number },
        agentRate: { type: Number },
        customerRate: { type: Number },
        marginPiasters: { type: Number },
        agentCostLYD: { type: Number },
        customerChargeLYD: { type: Number },
        profitLYD: { type: Number }
    },
    lines: { type: [journalLineSchema], default: [] },
    debitTotal: { type: Number, default: 0 },
    creditTotal: { type: Number, default: 0 },
    reversalOf: { type: String, trim: true },
    createdById: { type: mongoose.Schema.Types.ObjectId },
    createdByModel: { type: String, trim: true },
    createdByName: { type: String, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

agencyJournalSchema.pre('validate', function validateBalancedJournal() {
    if (!this.idempotencyKey) this.idempotencyKey = this.eventId;
    const totals = (this.lines || []).reduce((result, line) => {
        result[line.side] += Number(line.amount) || 0;
        return result;
    }, { debit: 0, credit: 0 });
    this.debitTotal = Number(totals.debit.toFixed(3));
    this.creditTotal = Number(totals.credit.toFixed(3));
    if (Math.abs(this.debitTotal - this.creditTotal) > 0.001) {
        this.invalidate('lines', 'Agency journal entry is not balanced');
    }
});

agencyJournalSchema.index({ ownerId: 1, createdAt: -1 });
agencyJournalSchema.index({ ownerId: 1, customerId: 1, createdAt: -1 });
agencyJournalSchema.index({ ownerId: 1, eventType: 1, createdAt: -1 });
agencyJournalSchema.index({ ownerId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

installAppendOnlyGuards(agencyJournalSchema, 'agency_journal');

module.exports = mongoose.models?.AgencyJournal || mongoose.model('AgencyJournal', agencyJournalSchema);
