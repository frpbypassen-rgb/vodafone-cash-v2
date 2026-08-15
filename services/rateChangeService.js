'use strict';

const Settings = require('../models/Settings');
const Notification = require('../models/Notification');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const ClientCompany = require('../models/ClientCompany');
const {
    sendRateChangeWhatsAppNotifications,
    formatRateChanges
} = require('./whatsappRateChangeDeliveryService');

const RATE_CHANGE_DELAY_MS = 60 * 1000;
const RATE_CHANGE_MONITOR_INTERVAL_MS = 5 * 1000;
let activationTimer = null;
let activationMonitor = null;

const recipientIds = async () => {
    const [users, clientEmployees, agentEmployees, subAccounts, companies] = await Promise.all([
        User.find({ status: 'active' }).select('_id phone webUsername').lean(),
        ClientEmployee.find({ status: 'active' }).select('_id phone webUsername').lean(),
        AgentEmployee.find({ status: 'active' }).select('_id phone webUsername').lean(),
        SubAccount.find({ status: 'active' }).select('_id phone username').lean(),
        ClientCompany.find({ status: 'active' }).select('_id phone webUsername').lean()
    ]);
    return [...users, ...clientEmployees, ...agentEmployees, ...subAccounts, ...companies]
        .flatMap((account) => [account.phone, account.webUsername, account.username, account._id])
        .filter(Boolean)
        .map(String);
};

const notifyClients = async ({ title, message, metadata }) => {
    const ids = [...new Set(await recipientIds())];
    await Notification.insertMany(ids.map((userId) => ({
        userId,
        audience: 'client',
        type: 'rate_change',
        title,
        message,
        metadata
    })), { ordered: false }).catch(() => {});
};

const emitRateEvent = (app, event, payload) => {
    const io = app?.get?.('io');
    if (io) io.emit(event, payload);
};

const formatCurrentRateChanges = ({ changes = {}, previousRates = {} }) => (
    formatRateChanges({ changes, previousRates })
        .split('\n')
        .map((line) => {
            const arrowIndex = line.lastIndexOf('←');
            if (arrowIndex < 0) return line;
            const label = line.slice(0, line.indexOf(':')).trim();
            const currentRate = line.slice(arrowIndex + 1).trim();
            return `${label}: ${currentRate}`;
        })
        .join('\n')
);

const buildRateChangePayload = ({ changes = {}, previousRates = {}, effectiveAt = null }) => ({
    changes,
    previousRates,
    rateChangesText: formatRateChanges({ changes, previousRates }),
    currentRatesText: formatCurrentRateChanges({ changes, previousRates }),
    ...(effectiveAt ? { effectiveAt: new Date(effectiveAt).toISOString() } : {})
});

const activatePendingRateUpdate = async ({ app } = {}) => {
    const settings = await Settings.findOne({});
    const pending = settings?.pendingRateUpdate;
    if (!settings || !pending?.effectiveAt || !pending?.changes) return null;
    if (new Date(pending.effectiveAt).getTime() > Date.now()) return null;

    const previousRates = pending.previousRates || {};
    const payload = {
        ...buildRateChangePayload({ changes: pending.changes, previousRates }),
        activatedAt: new Date().toISOString()
    };
    Object.assign(settings, pending.changes);
    settings.pendingRateUpdate = undefined;
    await settings.save();
    emitRateEvent(app, 'exchange_rates_updated', payload);
    emitRateEvent(app, 'rate_change_activated', payload);
    await notifyClients({
        title: 'تم تحديث أسعار الصرف',
        message: `تم تفعيل أسعار الصرف الجديدة. السعر الحالي:\n${payload.currentRatesText}`,
        metadata: { event: 'activated', ...payload }
    });
    return payload;
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

const scheduleRateUpdate = async ({ settings, changes, actor, app }) => {
    const effectiveAt = new Date(Date.now() + RATE_CHANGE_DELAY_MS);
    const previousRates = Object.fromEntries(
        Object.keys(changes || {}).map((field) => [field, settings[field]])
    );
    settings.pendingRateUpdate = {
        effectiveAt,
        changes,
        previousRates,
        createdBy: String(actor || ''),
        createdAt: new Date()
    };
    await settings.save();
    const payload = {
        ...buildRateChangePayload({ changes, previousRates, effectiveAt }),
        delaySeconds: 60
    };
    armPendingRateActivation({ app, effectiveAt });
    emitRateEvent(app, 'rate_change_scheduled', payload);
    await notifyClients({
        title: 'تحديث أسعار الصرف قريباً',
        message: `سيتم تطبيق أسعار صرف جديدة خلال 60 ثانية.\n${payload.rateChangesText}`,
        metadata: { event: 'scheduled', ...payload }
    });
    // WhatsApp delivery is tracked per account and must not delay saving the
    // scheduled rate update or the live dashboard notification.
    void sendRateChangeWhatsAppNotifications({
        changes,
        previousRates,
        effectiveAt
    }).catch((error) => console.error('[RateChange] WhatsApp notification failed:', error.message));
    return payload;
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

// Keeps scheduled rates reliable when the web process is restarted or a
// previous in-memory timeout is lost before the effective time.
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
