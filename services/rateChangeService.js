'use strict';

const Settings = require('../models/Settings');
const { sendRateChangeWhatsAppNotifications } = require('./whatsappRateChangeDeliveryService');
const {
    createRateAlertCampaign,
    activateRateAlertCampaign,
    recordWhatsAppDeliverySummary,
    recordTargetedAccounts
} = require('./rateAlerts/rateAlertCampaignService');
const { sendRateAlertWebPush } = require('./rateAlerts/webPushService');
const {
    DEFAULT_DELAY_SECONDS,
    normalizeDelaySeconds,
    formatDelay,
    buildRateAlertAudience
} = require('./rateAlerts/rateAlertAudienceService');

const RATE_CHANGE_MONITOR_INTERVAL_MS = 5 * 1000;
let activationTimer = null;
let activationMonitor = null;
let activationInFlight = false;

const emitRateRefresh = (app, event, campaignReference = '') => {
    const io = app?.get?.('io');
    if (!io) return;
    // This public signal carries no prices. Authenticated clients fetch only
    // the effective-rate alert for their own financial account.
    io.emit('rate_change_refresh', {
        event,
        campaignReference: String(campaignReference || ''),
        occurredAt: new Date().toISOString()
    });
};

// Compatibility helper for callers that already own a recipient-specific
// payload. It never renders raw administration fields or pricing tiers.
const buildRateChangePayload = ({ payload, effectiveAt, delaySeconds, campaignReference = '' } = {}) => ({
    ...(payload || {}),
    ...(effectiveAt ? { effectiveAt: new Date(effectiveAt).toISOString() } : {}),
    delaySeconds: normalizeDelaySeconds(delaySeconds || payload?.delaySeconds || DEFAULT_DELAY_SECONDS),
    campaignReference: String(campaignReference || payload?.campaignReference || '')
});

const activatePendingRateUpdate = async ({ app } = {}) => {
    if (activationInFlight) return null;
    const settings = await Settings.findOne({});
    const pending = settings?.pendingRateUpdate;
    if (!settings || !pending?.effectiveAt || !pending?.changes) return null;
    if (new Date(pending.effectiveAt).getTime() > Date.now()) return null;
    activationInFlight = true;
    try {
        const delaySeconds = normalizeDelaySeconds(pending.delaySeconds || settings.rateChangeDelaySeconds);
        const audience = await buildRateAlertAudience({
            settings,
            changes: pending.changes,
            effectiveAt: pending.effectiveAt,
            delaySeconds,
            campaignReference: pending.campaignReference
        });
        Object.assign(settings, pending.changes);
        const campaignReference = pending.campaignReference || '';
        settings.pendingRateUpdate = undefined;
        settings.ratesUpdatedAt = new Date();
        await settings.save();
        await activateRateAlertCampaign(campaignReference).catch((error) => {
            console.error('[RateAlert] campaign activation failed:', error.message);
        });
        emitRateRefresh(app, 'activated', campaignReference);
        const io = app?.get?.('io');
        if (io) io.emit('exchange_rates_updated', { source: 'general' });
        return {
            activatedAt: new Date().toISOString(),
            campaignReference,
            targetedAccounts: audience.length
        };
    } finally {
        activationInFlight = false;
    }
};

const armPendingRateActivation = ({ app, effectiveAt }) => {
    if (activationTimer) clearTimeout(activationTimer);
    const delay = Math.max(0, new Date(effectiveAt).getTime() - Date.now());
    activationTimer = setTimeout(() => {
        activatePendingRateUpdate({ app }).catch((error) => {
            console.error('[RateChange] activation failed:', error.message);
        });
    }, delay + 30);
    activationTimer.unref?.();
};

const scheduleRateUpdate = async ({ settings, changes, actor, app, delaySeconds }) => {
    const safeDelaySeconds = normalizeDelaySeconds(delaySeconds || settings.rateChangeDelaySeconds);
    const effectiveAt = new Date(Date.now() + (safeDelaySeconds * 1000));
    const previousRates = Object.fromEntries(
        Object.keys(changes || {}).map((field) => [field, settings[field]])
    );
    settings.rateChangeDelaySeconds = safeDelaySeconds;
    settings.pendingRateUpdate = {
        effectiveAt,
        changes,
        previousRates,
        delaySeconds: safeDelaySeconds,
        createdBy: String(actor || ''),
        createdAt: new Date(),
        campaignReference: ''
    };
    await settings.save();

    let campaign = null;
    try {
        campaign = await createRateAlertCampaign({
            effectiveAt,
            delaySeconds: safeDelaySeconds,
            changes,
            previousRates,
            createdBy: String(actor || '')
        });
        settings.pendingRateUpdate.campaignReference = campaign.reference;
        await settings.save();
    } catch (error) {
        console.error('[RateAlert] campaign creation failed:', error.message);
    }

    const campaignReference = campaign?.reference || '';
    const audience = await buildRateAlertAudience({
        settings,
        changes,
        effectiveAt,
        delaySeconds: safeDelaySeconds,
        campaignReference
    });
    await recordTargetedAccounts(campaignReference, audience.length).catch(() => {});
    armPendingRateActivation({ app, effectiveAt });
    emitRateRefresh(app, 'scheduled', campaignReference);

    const whatsappRecipients = audience.flatMap((recipient) => recipient.phoneRecipients || []);
    void sendRateChangeWhatsAppNotifications({
        campaignReference,
        recipients: whatsappRecipients,
        changes,
        previousRates,
        effectiveAt,
        delaySeconds: safeDelaySeconds
    }).then((summary) => recordWhatsAppDeliverySummary(campaignReference, summary))
        .catch((error) => console.error('[RateChange] WhatsApp notification failed:', error.message));
    void sendRateAlertWebPush({ audience })
        .catch((error) => console.error('[RateAlert] web push notification failed:', error.message));

    return {
        effectiveAt: effectiveAt.toISOString(),
        delaySeconds: safeDelaySeconds,
        countdown: formatDelay(safeDelaySeconds),
        campaignReference,
        targetedAccounts: audience.length
    };
};

const restorePendingRateActivation = async ({ app } = {}) => {
    const settings = await Settings.findOne({}).lean();
    const effectiveAt = settings?.pendingRateUpdate?.effectiveAt;
    if (!effectiveAt) return null;

    if (new Date(effectiveAt).getTime() <= Date.now()) {
        return activatePendingRateUpdate({ app });
    }

    armPendingRateActivation({ app, effectiveAt });
    return { effectiveAt: new Date(effectiveAt).toISOString(), restored: true };
};

const startRateChangeActivationMonitor = ({ app } = {}) => {
    if (activationMonitor) return activationMonitor;
    activationMonitor = setInterval(() => {
        activatePendingRateUpdate({ app }).catch((error) => {
            console.error('[RateChange] monitor failed:', error.message);
        });
    }, RATE_CHANGE_MONITOR_INTERVAL_MS);
    activationMonitor.unref?.();
    return activationMonitor;
};

module.exports = {
    activatePendingRateUpdate,
    scheduleRateUpdate,
    restorePendingRateActivation,
    startRateChangeActivationMonitor,
    buildRateChangePayload
};
