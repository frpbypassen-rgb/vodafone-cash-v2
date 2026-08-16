'use strict';

const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const User = require('../models/User');
const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const { SERVICE_RATE_CONFIG } = require('../utils/rateHelper');
const { formatDelay, normalizeDelaySeconds } = require('./rateAlerts/rateAlertAudienceService');
const {
    getWhatChimpConfigurationStatus,
    getWhatChimpTemplateReadiness,
    normalizeWhatsAppPhone,
    sendRateChange
} = require('./whatsappService');
const { DELIVERY_STAGE_LABELS } = require('./whatsappReceiptDeliveryService');

const ACTIVE_STATUSES = { status: 'active' };
const SENT_STATUSES = new Set(['sent', 'delivered', 'read']);

const RATE_FIELD_META = Object.entries(SERVICE_RATE_CONFIG).flatMap(([serviceKey, config]) => (
    [1, 2, 3].map((tier) => ({
        field: `${config.fieldPrefix}Level${tier}`,
        label: config.label,
        serviceKey,
        tier
    }))
));

const formatRate = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric)
        : '---';
};

const uniqueRecipients = (rows) => {
    const seen = new Set();
    return rows.filter((recipient) => {
        const key = String(recipient.phone || '').replace(/\D/g, '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const getRateChangeRecipients = async () => {
    const [users, companies, subAccounts, clientEmployees, agentEmployees] = await Promise.all([
        User.find(ACTIVE_STATUSES).select('_id name phone webUsername role').lean(),
        ClientCompany.find(ACTIVE_STATUSES).select('_id name phone webUsername').lean(),
        SubAccount.find(ACTIVE_STATUSES).select('_id name phone username').lean(),
        ClientEmployee.find(ACTIVE_STATUSES).select('_id name phone webUsername').lean(),
        AgentEmployee.find(ACTIVE_STATUSES).select('_id name phone webUsername').lean()
    ]);

    const mapRows = (rows, model) => rows.map((account) => ({
        id: account._id,
        name: account.name || account.webUsername || account.username || account.phone || 'عميل الأهرام',
        phone: account.phone || '',
        model
    }));

    return uniqueRecipients([
        ...mapRows(users, 'User'),
        ...mapRows(companies, 'ClientCompany'),
        ...mapRows(subAccounts, 'SubAccount'),
        ...mapRows(clientEmployees, 'ClientEmployee'),
        ...mapRows(agentEmployees, 'AgentEmployee')
    ]);
};

const formatRateChanges = ({ changes = {}, previousRates = {} }) => {
    const rendered = new Set();
    const renderedServices = new Set();
    const lines = [];
    RATE_FIELD_META.forEach((meta) => {
        if (changes[meta.field] === undefined) return;
        rendered.add(meta.field);
        if (renderedServices.has(meta.serviceKey)) return;
        renderedServices.add(meta.serviceKey);
        lines.push(`${meta.label}: ${formatRate(previousRates[meta.field])} ← ${formatRate(changes[meta.field])}`);
    });

    // Legacy rateLevel fields mirror cashRate fields. Do not repeat them when
    // cash fields are included in the same scheduled update.
    [1, 2, 3].forEach((tier) => {
        const field = `rateLevel${tier}`;
        if (changes[field] === undefined) return;
        if (changes[`cashRateLevel${tier}`] !== undefined) {
            rendered.add(field);
            return;
        }
        rendered.add(field);
        if (!renderedServices.has('vodafone')) {
            renderedServices.add('vodafone');
            lines.push(`تحويل كاش: ${formatRate(previousRates[field])} ← ${formatRate(changes[field])}`);
        }
    });

    Object.keys(changes)
        .filter((field) => !rendered.has(field))
        .forEach((field) => lines.push(`${field}: ${formatRate(previousRates[field])} ← ${formatRate(changes[field])}`));

    return lines.join('\n').slice(0, 3000) || 'تم تحديث أسعار الصرف.';
};

const markStage = (delivery, key, status, detail = '') => {
    const stages = Array.isArray(delivery.stages) ? [...delivery.stages] : [];
    const stage = {
        key,
        label: DELIVERY_STAGE_LABELS[key] || key,
        status,
        detail: String(detail || '').slice(0, 1000),
        occurredAt: new Date()
    };
    const index = stages.findIndex((item) => item?.key === key);
    if (index >= 0) stages[index] = stage;
    else stages.push(stage);
    delivery.stages = stages;
    delivery.metadata = {
        ...(delivery.metadata || {}),
        currentStage: key,
        currentStageLabel: stage.label,
        currentStageStatus: status
    };
    delivery.markModified?.('stages');
    delivery.markModified?.('metadata');
};

const sendOneRateChange = async ({
    recipient,
    reference,
    effectiveAt,
    delaySeconds,
    rateChanges,
    rateChangeConfiguration
}) => {
    let normalizedPhone;
    try {
        normalizedPhone = normalizeWhatsAppPhone(recipient.phone);
    } catch (error) {
        return { success: false, skipped: true, code: error.code || 'WHATSAPP_PHONE_INVALID', message: error.message };
    }

    let delivery = await WhatsAppDelivery.findOne({
        kind: 'rate_change',
        reference,
        recipientPhone: normalizedPhone
    });
    if (delivery && SENT_STATUSES.has(delivery.status)) {
        return { success: true, duplicate: true, deliveryId: String(delivery._id) };
    }
    delivery = delivery || new WhatsAppDelivery({ kind: 'rate_change', reference, recipientPhone: normalizedPhone });
    delivery.recipientName = recipient.name;
    delivery.recipientModel = recipient.model;
    delivery.recipientId = recipient.id;
    delivery.status = 'sending';
    delivery.failureCode = '';
    delivery.failureReason = '';
    const countdown = formatDelay(delaySeconds);
    delivery.metadata = {
        ...(delivery.metadata || {}),
        effectiveAt: new Date(effectiveAt).toISOString(),
        rateChanges,
        countdown,
        delaySeconds: normalizeDelaySeconds(delaySeconds)
    };
    markStage(delivery, 'rate_change_prepared', 'success');
    markStage(delivery, 'phone_normalized', 'success', normalizedPhone);

    const configuration = rateChangeConfiguration || getWhatChimpConfigurationStatus();
    if (!configuration.rateChangeReady || configuration.rateChangeOperational === false) {
        delivery.status = 'failed';
        delivery.failureCode = configuration.rateChangeReady
            ? 'WHATCHIMP_RATE_CHANGE_TEMPLATE_NOT_APPROVED'
            : 'WHATCHIMP_RATE_CHANGE_NOT_READY';
        delivery.failureReason = configuration.rateChangeReady
            ? 'قالب WhatsApp الخاص بتغيير أسعار الصرف غير معتمد أو تعذر التحقق من اعتماده.'
            : 'قالب WhatsApp الخاص بتغيير أسعار الصرف غير مكتمل.';
        markStage(delivery, 'rate_change_configuration', 'failed', delivery.failureReason);
        await delivery.save();
        return { success: false, code: delivery.failureCode, message: delivery.failureReason, deliveryId: String(delivery._id) };
    }

    markStage(delivery, 'rate_change_configuration', 'success');
    markStage(delivery, 'provider_request', 'active');
    await delivery.save();
    const result = await sendRateChange({
        phone: normalizedPhone,
        accountName: recipient.name,
        countdown,
        rateChanges,
        effectiveAt
    });
    delivery.status = result.success ? 'sent' : 'failed';
    delivery.messageId = result.messageId || '';
    delivery.templateName = result.templateName || process.env.WHATCHIMP_RATE_CHANGE_TEMPLATE || '';
    delivery.failureCode = result.success ? '' : (result.code || 'WHATCHIMP_REQUEST_FAILED');
    delivery.failureReason = result.success ? '' : (result.message || 'تعذر إرسال إشعار تغيير السعر.');
    delivery.sentAt = result.success ? new Date() : undefined;
    markStage(delivery, 'provider_request', result.success ? 'success' : 'failed', result.message || '');
    markStage(delivery, 'provider_acceptance', result.success ? 'success' : 'failed', result.message || '');
    if (result.success) markStage(delivery, 'provider_delivery', 'waiting', 'بانتظار تأكيد التسليم من WhatsApp.');
    await delivery.save();
    return { ...result, deliveryId: String(delivery._id) };
};

const runWithConcurrency = async (items, limit, task) => {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        const results = [];
        while (queue.length) results.push(await task(queue.shift()));
        return results;
    });
    return (await Promise.all(workers)).flat();
};

const sendRateChangeWhatsAppNotifications = async ({
    campaignReference,
    recipients,
    changes,
    previousRates,
    effectiveAt,
    delaySeconds = 60
}) => {
    const targetRecipients = Array.isArray(recipients) ? uniqueRecipients(recipients) : await getRateChangeRecipients();
    const reference = campaignReference || `RATE-CHANGE-${new Date(effectiveAt).toISOString()}`;
    const fallbackRateChanges = formatRateChanges({ changes, previousRates });
    const rateChangeConfiguration = await getWhatChimpTemplateReadiness().catch(() => getWhatChimpConfigurationStatus());
    const results = await runWithConcurrency(targetRecipients, 5, (recipient) => (
        sendOneRateChange({
            recipient,
            reference,
            effectiveAt,
            delaySeconds: recipient.payload?.delaySeconds || delaySeconds,
            rateChanges: recipient.payload?.rateChangesText || recipient.rateChangesText || fallbackRateChanges,
            rateChangeConfiguration
        })
            .catch((error) => ({ success: false, code: 'RATE_CHANGE_DELIVERY_FAILED', message: error.message }))
    ));
    return {
        reference,
        attempted: targetRecipients.length,
        sent: results.filter((result) => result.success && !result.duplicate).length,
        failed: results.filter((result) => !result.success).length,
        skipped: results.filter((result) => result.skipped).length,
        results
    };
};

module.exports = {
    formatRateChanges,
    getRateChangeRecipients,
    sendRateChangeWhatsAppNotifications
};
