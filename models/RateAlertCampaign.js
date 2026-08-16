'use strict';

const mongoose = require('mongoose');

// A durable record for a scheduled rate announcement. Keeping this outside of
// Settings lets notifications and delivery monitoring evolve independently.
const rateAlertCampaignSchema = new mongoose.Schema({
    reference: { type: String, required: true, unique: true, index: true },
    status: {
        type: String,
        enum: ['scheduled', 'active', 'cancelled'],
        default: 'scheduled',
        index: true
    },
    effectiveAt: { type: Date, required: true, index: true },
    activatedAt: { type: Date, default: null },
    changes: { type: Object, required: true },
    previousRates: { type: Object, required: true },
    createdBy: { type: String, default: '' },
    audience: { type: [String], default: () => ['client', 'company', 'agent'] },
    whatsapp: {
        attempted: { type: Number, default: 0 },
        sent: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        lastAttemptAt: { type: Date, default: null }
    }
}, { timestamps: true, versionKey: false });

rateAlertCampaignSchema.index({ status: 1, effectiveAt: 1 });

module.exports = mongoose.model('RateAlertCampaign', rateAlertCampaignSchema);
