'use strict';

const { createHash, randomUUID } = require('node:crypto');
const Endpoint = require('../models/MerchantWebhookEndpoint');
const Delivery = require('../models/MerchantWebhookDelivery');
const Settings = require('../models/Settings');
const { webhookOwnerQuery } = require('./merchantIntegrationService');
const { MERCHANT_RATES_UPDATED, buildMerchantRates } = require('../utils/merchantRates');

const subscribed = { enabled: true, events: MERCHANT_RATES_UPDATED };
const batchSize = 50;
let cursor = null;

const stageSnapshot = async (endpoint, settings) => {
    const query = webhookOwnerQuery(endpoint);
    if (!query) return false;
    const owner = await query.Model.findOne(query.filter).select('tier rateMode rateOffsets exchangeRate').lean();
    if (!owner) return false;

    const rates = buildMerchantRates(owner, settings);
    const signature = createHash('sha256').update(JSON.stringify(rates)).digest('hex');
    if (endpoint.rateSnapshot?.signature === signature) return false;

    const previous = endpoint.rateSnapshot?.sequence;
    const sequence = (previous || 0) + 1;
    const eventId = randomUUID();
    // Advancing the sequence and staging delivery must commit together.
    return Endpoint.db.transaction(async (session) => {
        const result = await Endpoint.updateOne({
            _id: endpoint._id,
            ...subscribed,
            'rateSnapshot.sequence': previous ?? { $exists: false }
        }, { $set: { rateSnapshot: { signature, sequence } } }, { session, timestamps: false });
        if (result.modifiedCount !== 1) return false;

        await Delivery.create([{
            endpointId: endpoint._id,
            tenantId: endpoint.tenantId,
            ownerId: endpoint.ownerId,
            ownerModel: endpoint.ownerModel,
            eventId,
            eventType: MERCHANT_RATES_UPDATED,
            payload: {
                id: eventId,
                type: MERCHANT_RATES_UPDATED,
                created_at: new Date().toISOString(),
                data: { sequence, ...rates }
            }
        }], { session });
        return true;
    });
};

const stageMerchantRateWebhooks = async () => {
    const endpoints = await Endpoint.find({ ...subscribed, ...(cursor ? { _id: { $gt: cursor } } : {}) })
        .select('tenantId ownerId ownerModel +rateSnapshot').sort({ _id: 1 }).limit(batchSize).lean();
    const result = { staged: 0, failed: 0 };
    if (endpoints.length) {
        const settings = await Settings.findOne({}).lean();
        for (const endpoint of endpoints) {
            try {
                if (await stageSnapshot(endpoint, settings)) result.staged++;
            } catch (_) {
                result.failed++;
            }
        }
    }
    cursor = endpoints.length === batchSize ? endpoints.at(-1)._id : null;
    return result;
};

module.exports = { stageMerchantRateWebhooks };
