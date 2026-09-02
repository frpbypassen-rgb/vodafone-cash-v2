'use strict';

const RateAlertCampaign = require('../../models/RateAlertCampaign');

const buildReference = (effectiveAt) => {
    const stamp = new Date(effectiveAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `RATE-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
};

const createRateAlertCampaign = async ({
    effectiveAt,
    delaySeconds,
    changes,
    previousRates,
    createdBy,
    targetedAccounts = 0
}) => {
    const campaign = await RateAlertCampaign.create({
        reference: buildReference(effectiveAt),
        effectiveAt,
        delaySeconds,
        changes,
        previousRates,
        createdBy,
        targetedAccounts
    });
    return campaign;
};

const activateRateAlertCampaign = async (reference) => {
    if (!reference) return null;
    const campaign = await RateAlertCampaign.findOneAndUpdate(
        { reference, status: 'scheduled' },
        { $set: { status: 'active', activatedAt: new Date() } },
        { new: true }
    );
    // The campaign is only needed while a price is pending. Once active, do
    // not retain a catalogue of prior prices in notification records.
    await RateAlertCampaign.updateMany(
        { status: { $in: ['active', 'cancelled'] } },
        { $unset: { changes: 1, previousRates: 1 } }
    );
    return campaign;
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

const recordTargetedAccounts = async (reference, targetedAccounts) => {
    if (!reference) return null;
    return RateAlertCampaign.findOneAndUpdate(
        { reference },
        { $set: { targetedAccounts: Number(targetedAccounts || 0) } },
        { new: true }
    );
};

module.exports = {
    createRateAlertCampaign,
    activateRateAlertCampaign,
    recordWhatsAppDeliverySummary,
    recordTargetedAccounts
};
