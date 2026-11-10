'use strict';

jest.mock('dns', () => ({
    promises: { lookup: jest.fn(async () => [{ address: '203.0.113.10', family: 4 }]) }
}));
jest.mock('axios', () => ({ post: jest.fn(async () => ({ status: 204 })) }));
jest.mock('../utils/encryption', () => ({
    ...jest.requireActual('../utils/encryption'),
    decrypt: jest.fn(() => 'fixture-webhook-secret')
}));

const axios = require('axios');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Company = require('../models/ClientCompany');
const User = require('../models/User');
const Settings = require('../models/Settings');
const Endpoint = require('../models/MerchantWebhookEndpoint');
const Delivery = require('../models/MerchantWebhookDelivery');

let mongo;
const previousMode = process.env.TENANT_MODE;
const previousWorker = process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;

beforeAll(async () => {
    process.env.TENANT_MODE = 'multi';
    process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = 'true';
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    await Promise.all([Endpoint.init(), Delivery.init(), Company.init(), User.init(), Settings.init()]);
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    if (previousMode === undefined) delete process.env.TENANT_MODE;
    else process.env.TENANT_MODE = previousMode;
    if (previousWorker === undefined) delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
    else process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = previousWorker;
});

test('queues only effective account-specific rates, in sequence, with tenant and subscription checks', async () => {
    const { stageMerchantRateWebhooks } = require('../services/merchantRateWebhookService');
    const tenantId = new mongoose.Types.ObjectId();
    const company = await Company.create({
        name: 'Company', tenantId, status: 'active', tier: 1, rateMode: 'custom',
        rateOffsets: { vodafone: 0.3 }, integrationAccess: { webhooksEnabled: true }
    });
    const agent = await User.create({
        name: 'Agent', role: 'agent', tenantId, status: 'active', tier: 2,
        webUsername: 'test-rate-agent', webPassword: 'fixture-password',
        integrationAccess: { webhooksEnabled: true }
    });
    const settings = await Settings.create({ cashRateLevel1: 6.4, cashRateLevel2: 7.1 });
    const subscribe = (ownerModel, ownerId, tenant, events) => Endpoint.create({
        ownerModel, ownerId, tenantId: tenant, events, url: 'https://example.test', secretEncrypted: 'fixture'
    });
    const first = await subscribe('ClientCompany', company._id, tenantId, ['rates.updated']);
    const second = await subscribe('User', agent._id, tenantId, ['rates.updated']);
    await subscribe('ClientCompany', company._id, new mongoose.Types.ObjectId(), ['rates.updated']);
    await subscribe('ClientCompany', company._id, tenantId, ['transfer.completed']);

    const prices = async (endpoint) => (await Delivery.find({ endpointId: endpoint._id }).sort({ 'payload.data.sequence': 1 }).lean())
        .map(({ payload }) => payload.data);
    await Promise.all([stageMerchantRateWebhooks(), stageMerchantRateWebhooks()]);
    expect(await Delivery.countDocuments()).toBe(2);
    expect(await prices(first)).toEqual([expect.objectContaining({ sequence: 1, exchange_rate: 6.7 })]);
    expect(await prices(second)).toEqual([expect.objectContaining({ sequence: 1, exchange_rate: 7.1 })]);

    await Settings.updateOne({ _id: settings._id }, { $set: {
        pendingRateUpdate: { effectiveAt: new Date(Date.now() + 60000), changes: { cashRateLevel1: 8.2 } }
    } });
    await stageMerchantRateWebhooks();
    expect(await Delivery.countDocuments()).toBe(2);

    await Settings.updateOne({ _id: settings._id }, { $set: { cashRateLevel1: 8.2 }, $unset: { pendingRateUpdate: 1 } });
    await stageMerchantRateWebhooks();
    await Company.updateOne({ _id: company._id }, { $set: { 'rateOffsets.vodafone': -1.5 } });
    await stageMerchantRateWebhooks();
    expect(await prices(first)).toEqual([
        expect.objectContaining({ sequence: 1, exchange_rate: 6.7 }),
        expect.objectContaining({ sequence: 2, exchange_rate: 8.5, service_rates: expect.objectContaining({ bank_account: 8.1 }) }),
        expect.objectContaining({ sequence: 3, exchange_rate: 6.7 })
    ]);
    expect(await prices(second)).toHaveLength(1);

    const { deliverWebhook, signPayload } = require('../services/merchantWebhookService');
    const agentDelivery = await Delivery.findOne({ endpointId: second._id });
    expect(await deliverWebhook(agentDelivery._id)).toEqual({ delivered: true });
    const [, body, { headers }] = axios.post.mock.calls[0];
    expect(JSON.parse(body).data).toEqual((await prices(second))[0]);
    expect(headers['x-ahrampay-event']).toBe('rates.updated');
    expect(headers['x-ahrampay-signature']).toBe(
        'sha256=' + signPayload('fixture-webhook-secret', headers['x-ahrampay-timestamp'], body)
    );
    await Endpoint.updateOne({ _id: first._id }, { $set: { events: ['transfer.completed'] } });
    const companyDelivery = await Delivery.findOne({ endpointId: first._id });
    expect(await deliverWebhook(companyDelivery._id)).toBeNull();
    expect(axios.post).toHaveBeenCalledTimes(1);

    await Company.updateOne({ _id: company._id }, { $set: { 'integrationAccess.webhooksEnabled': false } });
    await Endpoint.updateOne({ _id: first._id }, { $set: { events: ['rates.updated'] } });
    await Settings.updateOne({ _id: settings._id }, { $set: { cashRateLevel1: 9.1 } });
    await stageMerchantRateWebhooks();
    expect(await Delivery.countDocuments()).toBe(4);
}, 30000);
