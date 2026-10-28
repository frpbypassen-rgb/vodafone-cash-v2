'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Company = require('../models/ClientCompany'),
    Endpoint = require('../models/MerchantWebhookEndpoint'),
    Delivery = require('../models/MerchantWebhookDelivery'),
    Event = require('../models/MerchantIntegrationEvent');
const {
    overview,
    classifyWebhook,
} = require('../services/merchantIntegrationOverviewService');
const { recordEvent } = require('../services/merchantIntegrationEventService');
let mongo;
const saved = process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Event.init();
});
afterEach(async () => {
    await Promise.all([
        Company.deleteMany({}),
        Endpoint.deleteMany({}),
        Delivery.deleteMany({}),
        Event.deleteMany({}),
    ]);
});
afterAll(async () => {
    if (saved === undefined) delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
    else process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = saved;
    await mongoose.disconnect();
    await mongo.stop();
});
test('permission, transport, configuration and confirmed delivery remain distinct readiness states', () => {
    const access = { webhooksEnabled: true };
    const stats = { enabled: 1, confirmed: 1, failing: 0 };
    expect(classifyWebhook({ webhooksEnabled: false }, stats, true).state).toBe(
        'unavailable',
    );
    expect(classifyWebhook(access, stats, false).state).toBe('stopped');
    expect(classifyWebhook(access, { ...stats, enabled: 0 }, true).state).toBe(
        'incomplete',
    );
    expect(
        classifyWebhook(access, { ...stats, confirmed: 0 }, true).state,
    ).toBe('available');
    expect(classifyWebhook(access, { ...stats, failing: 1 }, true).state).toBe(
        'error',
    );
    expect(classifyWebhook(access, stats, true).state).toBe('ready');
});
test('overview is read-only, owner-scoped and excludes delivery payloads, URLs and secrets', async () => {
    process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = 'false';
    const company = await Company.create({
        name: 'Owner',
        token: 'private-key',
        integrationAccess: { apiEnabled: true, webhooksEnabled: true },
    });
    const owner = { ownerModel: 'ClientCompany', ownerId: company._id };
    await Endpoint.create({
        ...owner,
        name: 'Receiver',
        url: 'https://example.com/?secret=private',
        secretEncrypted: 'do-not-return',
        enabled: true,
        lastSuccessAt: new Date(),
    });
    await Endpoint.create({
        ownerModel: 'ClientCompany',
        ownerId: new mongoose.Types.ObjectId(),
        url: 'https://foreign.example',
        secretEncrypted: 'foreign',
        enabled: true,
    });
    await Delivery.create({
        ...owner,
        endpointId: new mongoose.Types.ObjectId(),
        eventId: 'test-event',
        eventType: 'transfer.created',
        status: 'failed',
        payload: { token: 'payload-private' },
    });
    const before = await Company.findById(company._id).lean();
    const result = await overview(
        { isCompany: true, entity: company, permissions: { owner: true } },
        {
            socket: { remoteAddress: '127.0.0.1' },
            headers: {},
            app: { get: () => false },
        },
    );
    expect(result.webhooks).toMatchObject({
        total: 1,
        enabled: 1,
        state: 'stopped',
    });
    expect(result.readOnly).toBe(true);
    for (const secret of [
        'private-key',
        'do-not-return',
        'payload-private',
        'foreign.example',
        '?secret=private',
    ])
        expect(JSON.stringify(result)).not.toContain(secret);
    expect(await Company.findById(company._id).lean()).toEqual(before);
});
test('technical events aggregate repeats and only persist allowlisted diagnostics', async () => {
    const owner = {
        ownerModel: 'ClientCompany',
        ownerId: new mongoose.Types.ObjectId(),
    };
    const details = {
        operation: 'transfer',
        sourceIp: '::ffff:192.0.2.1',
        httpStatus: 403,
        token: 'never-store',
        payload: { password: 'never-store' },
        responsePreview: 'never-store',
    };
    await recordEvent(owner, 'IP_NOT_ALLOWED', details);
    await recordEvent(owner, 'IP_NOT_ALLOWED', details);
    expect(await Event.countDocuments({})).toBe(1);
    const row = await Event.findOne().lean();
    expect(row.count).toBe(2);
    expect(row.sourceIp).toBe('192.0.2.1');
    expect(JSON.stringify(row)).not.toContain('never-store');
    expect(row.expiresAt.getTime() - row.lastSeenAt.getTime()).toBe(
        7 * 86400000,
    );
    await recordEvent(owner, 'password=bad', details);
    expect(await Event.countDocuments({})).toBe(1);
});
