'use strict';

const RateAlertCampaign = require('../../models/RateAlertCampaign');

const buildReference = (effectiveAt) => {
    const stamp = new Date(effectiveAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `RATE-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
};

const createRateAlertCampaign = async ({ effectiveAt, changes, previousRates, createdBy }) => {
    const campaign = await RateAlertCampaign.create({
        reference: buildReference(effectiveAt),
        effectiveAt,
        changes,
        previousRates,
        createdBy
    });
    return campaign;
};

const activateRateAlertCampaign = async (reference) => {
    if (!reference) return null;
    return RateAlertCampaign.findOneAndUpdate(
        { reference, status: 'scheduled' },
        { $set: { status: 'active', activatedAt: new Date() } },
        { new: true }
    );
};

const recordWhatsAppDeliverySummary = async (reference, summary) => {
    if (!reference) return null;
    return RateAlertCampaign.findOneAndUpdate(
        { reference },
        {
            $set: {
                'whatsapp.attempted': Number(summary.attempted || 0),
                'whatsapp.sent': Number(summary.sent || 0),
                'whatsapp.failed': Number(summary.failed || 0),
                'whatsapp.lastAttemptAt': new Date()
            }
        },
        { new: true }
    );
};

module.exports = {
    createRateAlertCampaign,
    activateRateAlertCampaign,
    recordWhatsAppDeliverySummary
};
