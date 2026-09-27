'use strict';

jest.mock('axios', () => ({
    post: jest.fn(),
    get: jest.fn()
}));

jest.mock('dns', () => ({
    promises: {
        lookup: jest.fn(async () => [{ address: '203.0.113.10', family: 4 }])
    }
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const axios = require('axios');
const ClientEmployee = require('../models/ClientEmployee');
const Ledger = require('../models/Ledger');
const MerchantWebhookDelivery = require('../models/MerchantWebhookDelivery');
const MerchantWebhookEndpoint = require('../models/MerchantWebhookEndpoint');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { encrypt } = require('../utils/encryption');
const { classifyAdminWebhookLoad } = require('../public/js/admin-webhooks');
const { isMerchantWebhookWorkerEnabled } = require('../utils/runtimeControls');
const { listStaleSendingWebhooks } = require('../scripts/listStaleSendingWebhooks');
const {
    enqueueTransactionWebhook,
    processPendingWebhooks
} = require('../services/merchantWebhookService');
const merchantWebhookRoutes = require('../routes/merchantWebhooks');

jest.setTimeout(180000);

let replSet;
let app;
let requestTenantId = null;
let clientSession = null;
const savedEnv = {};

const trackedEnv = [
    'TENANT_MODE',
    'NODE_ENV',
    'APP_ENV',
    'ENVIRONMENT',
    'MERCHANT_WEBHOOK_WORKER_ENABLED',
    'MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER'
];

const indexedModels = () => [
    ClientEmployee,
    Ledger,
    MerchantWebhookDelivery,
    MerchantWebhookEndpoint,
    Transaction,
    User
];

beforeAll(async () => {
    trackedEnv.forEach((key) => { savedEnv[key] = process.env[key]; });
    indexedModels().forEach((model) => model.schema.set('autoIndex', false));
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replSet.getUri());
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = clientSession
            ? { ...clientSession }
            : { isLoggedIn: true, adminRole: 'master' };
        req.tenantId = requestTenantId;
        req.tenant = requestTenantId ? { _id: requestTenantId } : null;
        next();
    });
    app.use(merchantWebhookRoutes);
});

afterAll(async () => {
    trackedEnv.forEach((key) => {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    });
    indexedModels().forEach((model) => model.schema.set('autoIndex', true));
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
});

beforeEach(async () => {
    axios.post.mockReset();
    axios.post.mockResolvedValue({ status: 204, data: '' });
    requestTenantId = null;
    clientSession = null;
    delete process.env.TENANT_MODE;
    delete process.env.APP_ENV;
    delete process.env.ENVIRONMENT;
    delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
    delete process.env.MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER;
    process.env.NODE_ENV = 'test';
    await Promise.all([
        ClientEmployee.deleteMany({}),
        MerchantWebhookEndpoint.deleteMany({}),
        MerchantWebhookDelivery.deleteMany({}),
        Transaction.deleteMany({}),
        Ledger.deleteMany({}),
        User.deleteMany({})
    ]);
});

const createEndpoint = (fields) => MerchantWebhookEndpoint.create({
    url: 'https://hooks.example.test/pay',
    secretEncrypted: encrypt('webhook-secret'),
    events: ['transfer.completed'],
    enabled: true,
    ...fields
});

const createCompletedTx = (fields) => Transaction.create({
    customId: `ATT-WH-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
    amount: 100,
    status: 'completed',
    completedAt: new Date(),
    ...fields
});

const waitForTerminal = async (id) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const row = await MerchantWebhookDelivery.findById(id).lean();
        if (row && (row.status === 'delivered' || row.status === 'failed')) return row;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('delivery did not finish');
};

const endpointIds = (body) => body.endpoints.map((item) => item.id).sort();

const createCompanyEmployee = (fields) => ClientEmployee.create({
    name: 'Company manager',
    webUsername: `co-${new mongoose.Types.ObjectId()}`,
    webPassword: 'not-used',
    role: 'owner',
    canManageCompany: false,
    ...fields
});

const signInCompany = (employee) => {
    clientSession = {
        isClientLoggedIn: true,
        clientId: employee._id,
        accountType: 'company'
    };
};

const createDelivery = (endpoint, fields) => MerchantWebhookDelivery.create({
    endpointId: endpoint._id,
    ownerModel: endpoint.ownerModel,
    ownerId: endpoint.ownerId,
    tenantId: endpoint.tenantId,
    eventId: `evt-${new mongoose.Types.ObjectId()}`,
    eventType: 'transfer.completed',
    payload: { type: 'transfer.completed' },
    status: 'failed',
    attemptCount: 1,
    ...fields
});

describe('admin webhook visibility', () => {
    test('single mode lists a legacy tenant endpoint and a no-tenant endpoint', async () => {
        process.env.TENANT_MODE = 'single';
        const current = new mongoose.Types.ObjectId();
        const legacy = new mongoose.Types.ObjectId();
        requestTenantId = current;
        const legacyEndpoint = await createEndpoint({
            tenantId: legacy,
            ownerModel: 'ClientCompany',
            ownerId: new mongoose.Types.ObjectId(),
            name: 'legacy-endpoint'
        });
        const unscopedEndpoint = await createEndpoint({
            tenantId: null,
            ownerModel: 'User',
            ownerId: new mongoose.Types.ObjectId(),
            name: 'unscoped-endpoint'
        });
        const currentEndpoint = await createEndpoint({
            tenantId: current,
            ownerModel: 'ClientCompany',
            ownerId: new mongoose.Types.ObjectId(),
            name: 'current-endpoint'
        });

        const response = await request(app).get('/admin/api/webhooks').set('Accept', 'application/json');
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(endpointIds(response.body)).toEqual([
            String(legacyEndpoint._id),
            String(unscopedEndpoint._id),
            String(currentEndpoint._id)
        ].sort());
    });

    test('multi mode admin API does not show the other tenant endpoint or delivery', async () => {
        process.env.TENANT_MODE = 'multi';
        const tenantA = new mongoose.Types.ObjectId();
        const tenantB = new mongoose.Types.ObjectId();
        const endpointA = await createEndpoint({
            tenantId: tenantA,
            ownerModel: 'ClientCompany',
            ownerId: new mongoose.Types.ObjectId(),
            name: 'tenant-a'
        });
        const endpointB = await createEndpoint({
            tenantId: tenantB,
            ownerModel: 'ClientCompany',
            ownerId: new mongoose.Types.ObjectId(),
            name: 'tenant-b'
        });
        const deliveryB = await MerchantWebhookDelivery.create({
            tenantId: tenantB,
            endpointId: endpointB._id,
            ownerModel: 'ClientCompany',
            ownerId: endpointB.ownerId,
            eventId: `${new mongoose.Types.ObjectId()}:transfer.completed:completed`,
            eventType: 'transfer.completed',
            payload: { id: 'evt-b' },
            status: 'failed'
        });

        requestTenantId = tenantA;
        const asA = await request(app).get('/admin/api/webhooks').set('Accept', 'application/json');
        expect(asA.status).toBe(200);
        expect(endpointIds(asA.body)).toEqual([String(endpointA._id)]);
        expect(asA.body.deliveries.map((row) => String(row._id))).not.toContain(String(deliveryB._id));

        requestTenantId = tenantB;
        const asB = await request(app).get('/admin/api/webhooks').set('Accept', 'application/json');
        expect(endpointIds(asB.body)).toEqual([String(endpointB._id)]);
        expect(asB.body.deliveries.map((row) => String(row._id))).toEqual([String(deliveryB._id)]);

        requestTenantId = tenantA;
        const retry = await request(app)
            .post(`/admin/api/webhook-deliveries/${deliveryB._id}/retry`)
            .set('Accept', 'application/json')
            .send({});
        expect(retry.status).toBe(404);
        expect((await MerchantWebhookDelivery.findById(deliveryB._id).lean()).status).toBe('failed');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('single mode admin retry can see a legacy-tenant delivery', async () => {
        process.env.TENANT_MODE = 'single';
        delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
        const current = new mongoose.Types.ObjectId();
        requestTenantId = current;
        const endpoint = await createEndpoint({
            tenantId: new mongoose.Types.ObjectId(),
            ownerModel: 'User',
            ownerId: new mongoose.Types.ObjectId()
        });
        const delivery = await MerchantWebhookDelivery.create({
            tenantId: endpoint.tenantId,
            endpointId: endpoint._id,
            ownerModel: 'User',
            ownerId: endpoint.ownerId,
            eventId: `${new mongoose.Types.ObjectId()}:transfer.completed:completed`,
            eventType: 'transfer.completed',
            payload: { id: 'evt-legacy-retry' },
            status: 'failed',
            attemptCount: 1
        });

        const retry = await request(app)
            .post(`/admin/api/webhook-deliveries/${delivery._id}/retry`)
            .set('Accept', 'application/json')
            .send({});
        expect(retry.status).toBe(200);
        expect(retry.body.success).toBe(true);
        const finished = await waitForTerminal(delivery._id);
        expect(finished.status).toBe('delivered');
        expect(axios.post).toHaveBeenCalled();
    });
});

describe('enqueue tenant matching', () => {
    test('single mode creates a delivery for a legacy tenant endpoint and a no-tenant endpoint', async () => {
        process.env.TENANT_MODE = 'single';
        const current = new mongoose.Types.ObjectId();
        const legacyOwner = new mongoose.Types.ObjectId();
        const unscopedOwner = new mongoose.Types.ObjectId();
        const legacyEndpoint = await createEndpoint({
            tenantId: new mongoose.Types.ObjectId(),
            ownerModel: 'ClientCompany',
            ownerId: legacyOwner
        });
        const unscopedEndpoint = await createEndpoint({
            tenantId: null,
            ownerModel: 'ClientCompany',
            ownerId: unscopedOwner
        });
        const user = await User.create({
            webUsername: `wh-${new mongoose.Types.ObjectId()}`,
            webPassword: 'not-used',
            role: 'agent',
            balance: 2500
        });
        const ledger = await Ledger.create({
            entityId: user._id,
            entityModel: 'User',
            transactionId: 'ATT-WH-LEDGER',
            type: 'DEPOSIT',
            amount: 2500,
            balanceBefore: 0,
            balanceAfter: 2500,
            description: 'opening'
        });
        const legacyTx = await createCompletedTx({ tenantId: current, companyId: legacyOwner });
        const unscopedTx = await createCompletedTx({ tenantId: current, companyId: unscopedOwner });
        const financialSnapshot = async () => ({
            balance: (await User.findById(user._id).lean()).balance,
            ledger: await Ledger.find({ _id: ledger._id }).lean(),
            transactions: await Transaction.find({ _id: { $in: [legacyTx._id, unscopedTx._id] } })
                .select('status amount tenantId companyId')
                .sort({ _id: 1 })
                .lean()
        });
        const before = await financialSnapshot();

        const legacyIds = await enqueueTransactionWebhook('transfer.completed', legacyTx.toObject());
        const unscopedIds = await enqueueTransactionWebhook('transfer.completed', unscopedTx.toObject());
        expect(legacyIds).toHaveLength(1);
        expect(unscopedIds).toHaveLength(1);
        const legacyDelivery = await waitForTerminal(legacyIds[0]);
        const unscopedDelivery = await waitForTerminal(unscopedIds[0]);
        expect(String(legacyDelivery.endpointId)).toBe(String(legacyEndpoint._id));
        expect(String(unscopedDelivery.endpointId)).toBe(String(unscopedEndpoint._id));
        expect(legacyDelivery.status).toBe('delivered');
        expect(unscopedDelivery.status).toBe('delivered');
        const eventIds = axios.post.mock.calls.map((call) => call[2].headers['x-ahrampay-event-id']);
        expect(eventIds).toEqual(expect.arrayContaining([
            `${legacyTx._id}:transfer.completed:completed`,
            `${unscopedTx._id}:transfer.completed:completed`
        ]));

        expect(await financialSnapshot()).toEqual(before);
    });

    test('multi mode does not create a delivery on another tenant endpoint', async () => {
        process.env.TENANT_MODE = 'multi';
        const tenantA = new mongoose.Types.ObjectId();
        const tenantB = new mongoose.Types.ObjectId();
        const ownerId = new mongoose.Types.ObjectId();
        const endpointA = await createEndpoint({
            tenantId: tenantA,
            ownerModel: 'ClientCompany',
            ownerId
        });
        const endpointB = await createEndpoint({
            tenantId: tenantB,
            ownerModel: 'ClientCompany',
            ownerId
        });
        const unscoped = await createEndpoint({
            tenantId: null,
            ownerModel: 'ClientCompany',
            ownerId
        });
        const tx = await createCompletedTx({ tenantId: tenantA, companyId: ownerId });
        const ids = await enqueueTransactionWebhook('transfer.completed', tx.toObject());
        expect(ids).toHaveLength(1);
        const delivery = await MerchantWebhookDelivery.findById(ids[0]).lean();
        expect(String(delivery.endpointId)).toBe(String(endpointA._id));
        expect(await MerchantWebhookDelivery.countDocuments({ endpointId: endpointB._id })).toBe(0);
        expect(await MerchantWebhookDelivery.countDocuments({ endpointId: unscoped._id })).toBe(0);

        const bare = await createCompletedTx({ companyId: ownerId });
        const bareIds = await enqueueTransactionWebhook('transfer.completed', bare.toObject());
        expect(bareIds).toHaveLength(1);
        const bareDelivery = await MerchantWebhookDelivery.findById(bareIds[0]).lean();
        expect(String(bareDelivery.endpointId)).toBe(String(unscoped._id));
        expect(await MerchantWebhookDelivery.countDocuments({ endpointId: endpointB._id })).toBe(0);
    });
});

describe('stale sending reclaim', () => {
    const createSending = async (lockedAt, attemptCount = 1) => {
        const endpoint = await createEndpoint({
            ownerModel: 'User',
            ownerId: new mongoose.Types.ObjectId()
        });
        const eventId = `${new mongoose.Types.ObjectId()}:transfer.completed:completed`;
        const delivery = await MerchantWebhookDelivery.create({
            endpointId: endpoint._id,
            ownerModel: 'User',
            ownerId: endpoint.ownerId,
            eventId,
            eventType: 'transfer.completed',
            payload: { id: 'evt-stale' },
            status: 'sending',
            attemptCount,
            lockedAt,
            nextAttemptAt: new Date(Date.now() - 1000)
        });
        return { endpoint, delivery, eventId };
    };

    test('reclaims a stale sending row locked after the cutoff and keeps the same event id', async () => {
        const cutoff = new Date(Date.now() - (10 * 60 * 1000));
        process.env.MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER = cutoff.toISOString();
        const eligible = await createSending(new Date(Date.now() - (5 * 60 * 1000)));
        const historical = await createSending(new Date(Date.now() - (30 * 60 * 1000)));

        const selected = await processPendingWebhooks();
        expect(selected).toBe(1);
        const finished = await waitForTerminal(eligible.delivery._id);
        expect(finished.status).toBe('delivered');
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(axios.post.mock.calls[0][2].headers['x-ahrampay-event-id']).toBe(eligible.eventId);
        const stuck = await MerchantWebhookDelivery.findById(historical.delivery._id).lean();
        expect(stuck.status).toBe('sending');
        expect(stuck.attemptCount).toBe(1);
    });

    test('does not resend historical stale rows when the cutoff is unset or the attempt budget is spent', async () => {
        delete process.env.MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER;
        const unset = await createSending(new Date(Date.now() - (5 * 60 * 1000)));
        expect(await processPendingWebhooks()).toBe(0);
        expect((await MerchantWebhookDelivery.findById(unset.delivery._id).lean()).status).toBe('sending');
        await MerchantWebhookDelivery.deleteMany({});

        process.env.MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
        const exhausted = await createSending(new Date(Date.now() - (5 * 60 * 1000)), 6);
        expect(await processPendingWebhooks()).toBe(0);
        expect((await MerchantWebhookDelivery.findById(exhausted.delivery._id).lean()).status).toBe('sending');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('lists historical stuck sending ids without changing them', async () => {
        const source = fs.readFileSync(path.join(__dirname, '../scripts/listStaleSendingWebhooks.js'), 'utf8');
        expect(source).not.toMatch(/updateOne|updateMany|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|save\(/);
        const cutoff = new Date(Date.now() - (10 * 60 * 1000));
        const historical = await createSending(new Date(Date.now() - (30 * 60 * 1000)));
        const eligible = await createSending(new Date(Date.now() - (5 * 60 * 1000)));
        const before = await MerchantWebhookDelivery.find().sort({ _id: 1 }).lean();
        const listed = await listStaleSendingWebhooks(
            MerchantWebhookDelivery,
            new Date(),
            { MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER: cutoff.toISOString() }
        );
        const after = await MerchantWebhookDelivery.find().sort({ _id: 1 }).lean();
        expect(after).toEqual(before);
        expect(listed.readOnly).toBe(true);
        expect(listed.manualReviewIds).toEqual([String(historical.delivery._id)]);
        expect(listed.reclaimEligibleIds).toEqual([String(eligible.delivery._id)]);
        expect(JSON.stringify(listed)).not.toMatch(/hooks\.example|evt-stale|payload/);
    });
});

describe('admin webhook page load failure', () => {
    test('a failed response is not treated as an empty successful load', () => {
        const view = fs.readFileSync(path.join(__dirname, '../views/admin_webhooks.ejs'), 'utf8');
        const routeSource = fs.readFileSync(path.join(__dirname, '../routes/merchantWebhooks.js'), 'utf8');
        expect(view).toContain('classifyAdminWebhookLoad');
        expect(view).toContain('response.status');
        expect(view).toContain('تعذر تحميل مراقبة الويب هوك');
        expect(view).not.toContain('const d=await r.json(),s=d.summary||{}');
        expect(routeSource).toMatch(/\/admin\/api\/webhooks[\s\S]*adminAccountScope\(req\)/);
        expect(routeSource).toMatch(/webhook-deliveries\/:id\/retry[\s\S]*adminAccountScope\(req\)/);

        expect(classifyAdminWebhookLoad(500, { success: false })).toEqual({ ok: false });
        expect(classifyAdminWebhookLoad(200, { success: false, endpoints: [], deliveries: [] })).toEqual({ ok: false });
        expect(classifyAdminWebhookLoad(200, { success: true })).toEqual({ ok: false });
        const empty = classifyAdminWebhookLoad(200, {
            success: true,
            endpoints: [],
            deliveries: [],
            summary: {}
        });
        expect(empty.ok).toBe(true);
        expect(empty.endpoints).toEqual([]);
        expect(empty.summary).toEqual({});
    });
});

describe('company webhook routes', () => {
    const financialFixture = async () => {
        const user = await User.create({
            webUsername: `wh-${new mongoose.Types.ObjectId()}`,
            webPassword: 'not-used',
            role: 'agent',
            balance: 2500
        });
        const ledger = await Ledger.create({
            entityId: user._id,
            entityModel: 'User',
            transactionId: `ATT-WH-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
            type: 'DEPOSIT',
            amount: 2500,
            balanceBefore: 0,
            balanceAfter: 2500,
            description: 'opening'
        });
        return async () => ({
            balance: (await User.findById(user._id).lean()).balance,
            ledger: await Ledger.find({ _id: ledger._id }).lean()
        });
    };

    test('single mode shows and manages only this company, including its own legacy tenant', async () => {
        process.env.TENANT_MODE = 'single';
        const current = new mongoose.Types.ObjectId();
        const legacy = new mongoose.Types.ObjectId();
        const otherLegacy = new mongoose.Types.ObjectId();
        requestTenantId = current;
        const companyA = new mongoose.Types.ObjectId();
        const companyB = new mongoose.Types.ObjectId();
        const manager = await createCompanyEmployee({
            companyId: companyA,
            tenantId: legacy,
            role: 'owner',
            canManageCompany: false
        });
        signInCompany(manager);
        const ownLegacy = await createEndpoint({
            tenantId: legacy,
            ownerModel: 'ClientCompany',
            ownerId: companyA,
            name: 'own-legacy'
        });
        const ownMissing = await createEndpoint({
            tenantId: null,
            ownerModel: 'ClientCompany',
            ownerId: companyA,
            name: 'own-missing'
        });
        const otherSameTenant = await createEndpoint({
            tenantId: current,
            ownerModel: 'ClientCompany',
            ownerId: companyB,
            name: 'other-current'
        });
        const otherLegacyEndpoint = await createEndpoint({
            tenantId: otherLegacy,
            ownerModel: 'ClientCompany',
            ownerId: companyB,
            name: 'other-legacy'
        });
        const ownDelivery = await createDelivery(ownLegacy);
        const otherDelivery = await createDelivery(otherSameTenant);
        const otherLegacyDelivery = await createDelivery(otherLegacyEndpoint);
        const snapshot = await financialFixture();
        const before = await snapshot();
        const storedTenantIds = async () => (await MerchantWebhookEndpoint.find().sort({ _id: 1 }).lean())
            .map((row) => ({ id: String(row._id), tenantId: row.tenantId ? String(row.tenantId) : null }));
        const tenantsBefore = await storedTenantIds();

        const listed = await request(app).get('/client/api/webhooks');
        expect(listed.status).toBe(200);
        expect(endpointIds(listed.body)).toEqual([String(ownLegacy._id), String(ownMissing._id)].sort());
        const listedDeliveryIds = listed.body.deliveries.map((row) => String(row._id));
        expect(listedDeliveryIds).toEqual([String(ownDelivery._id)]);
        expect(listedDeliveryIds).not.toContain(String(otherDelivery._id));
        expect(listedDeliveryIds).not.toContain(String(otherLegacyDelivery._id));

        const patchOther = await request(app)
            .patch(`/client/api/webhooks/${otherSameTenant._id}`)
            .send({ name: 'taken-over' });
        expect(patchOther.status).toBe(404);
        const patchOtherLegacy = await request(app)
            .patch(`/client/api/webhooks/${otherLegacyEndpoint._id}`)
            .send({ name: 'taken-over-legacy' });
        expect(patchOtherLegacy.status).toBe(404);

        const deleteOther = await request(app).delete(`/client/api/webhooks/${otherSameTenant._id}`);
        expect(deleteOther.status).toBe(404);
        const deleteOtherLegacy = await request(app).delete(`/client/api/webhooks/${otherLegacyEndpoint._id}`);
        expect(deleteOtherLegacy.status).toBe(404);
        expect(await MerchantWebhookEndpoint.findById(otherSameTenant._id).lean()).toBeTruthy();
        expect(await MerchantWebhookEndpoint.findById(otherLegacyEndpoint._id).lean()).toBeTruthy();

        const retryOther = await request(app).post(`/client/api/webhook-deliveries/${otherDelivery._id}/retry`);
        expect(retryOther.status).toBe(404);
        const retryOtherLegacy = await request(app).post(`/client/api/webhook-deliveries/${otherLegacyDelivery._id}/retry`);
        expect(retryOtherLegacy.status).toBe(404);
        expect(axios.post).not.toHaveBeenCalled();
        expect((await MerchantWebhookDelivery.findById(otherDelivery._id).lean()).status).toBe('failed');
        expect((await MerchantWebhookDelivery.findById(otherLegacyDelivery._id).lean()).status).toBe('failed');

        const patchOwn = await request(app)
            .patch(`/client/api/webhooks/${ownLegacy._id}`)
            .send({ name: 'own-legacy-renamed' });
        expect(patchOwn.status).toBe(200);
        expect(patchOwn.body.endpoint.name).toBe('own-legacy-renamed');
        const renamed = await MerchantWebhookEndpoint.findById(ownLegacy._id).lean();
        expect(String(renamed.tenantId)).toBe(String(legacy));

        const retryOwn = await request(app).post(`/client/api/webhook-deliveries/${ownDelivery._id}/retry`);
        expect(retryOwn.status).toBe(200);
        expect(retryOwn.body.success).toBe(true);
        const finished = await waitForTerminal(ownDelivery._id);
        expect(finished.status).toBe('delivered');
        expect(axios.post).toHaveBeenCalled();

        const deleteOwn = await request(app).delete(`/client/api/webhooks/${ownMissing._id}`);
        expect(deleteOwn.status).toBe(200);
        expect(await MerchantWebhookEndpoint.findById(otherSameTenant._id).lean()).toMatchObject({ name: 'other-current' });
        expect(await MerchantWebhookEndpoint.findById(otherLegacyEndpoint._id).lean()).toMatchObject({ name: 'other-legacy' });
        expect(await MerchantWebhookDelivery.findById(otherDelivery._id).lean()).toBeTruthy();
        expect(await storedTenantIds()).toEqual(tenantsBefore.filter((row) => row.id !== String(ownMissing._id)));
        expect(await snapshot()).toEqual(before);
    });

    test('multi mode hides another tenant even when ownerId matches, and a sub-user is refused', async () => {
        process.env.TENANT_MODE = 'multi';
        const tenantA = new mongoose.Types.ObjectId();
        const tenantB = new mongoose.Types.ObjectId();
        requestTenantId = tenantA;
        const companyA = new mongoose.Types.ObjectId();
        const companyB = new mongoose.Types.ObjectId();
        const manager = await createCompanyEmployee({
            companyId: companyA,
            tenantId: tenantA,
            role: 'owner'
        });
        signInCompany(manager);
        const ownHere = await createEndpoint({
            tenantId: tenantA,
            ownerModel: 'ClientCompany',
            ownerId: companyA,
            name: 'own-tenant-a'
        });
        const sameOwnerOtherTenant = await createEndpoint({
            tenantId: tenantB,
            ownerModel: 'ClientCompany',
            ownerId: companyA,
            name: 'own-tenant-b'
        });
        const otherCompany = await createEndpoint({
            tenantId: tenantA,
            ownerModel: 'ClientCompany',
            ownerId: companyB,
            name: 'other-tenant-a'
        });
        const unscopedSameOwner = await createEndpoint({
            tenantId: null,
            ownerModel: 'ClientCompany',
            ownerId: companyA,
            name: 'own-unscoped'
        });
        const foreignDelivery = await createDelivery(sameOwnerOtherTenant);
        const otherDelivery = await createDelivery(otherCompany);
        const snapshot = await financialFixture();
        const before = await snapshot();

        const listed = await request(app).get('/client/api/webhooks');
        expect(listed.status).toBe(200);
        expect(endpointIds(listed.body)).toEqual([String(ownHere._id)]);
        const listedDeliveryIds = listed.body.deliveries.map((row) => String(row._id));
        expect(listedDeliveryIds).not.toContain(String(foreignDelivery._id));
        expect(listedDeliveryIds).not.toContain(String(otherDelivery._id));

        expect((await request(app).patch(`/client/api/webhooks/${sameOwnerOtherTenant._id}`).send({ name: 'cross-tenant' })).status).toBe(404);
        expect((await request(app).patch(`/client/api/webhooks/${otherCompany._id}`).send({ name: 'cross-company' })).status).toBe(404);
        expect((await request(app).patch(`/client/api/webhooks/${unscopedSameOwner._id}`).send({ name: 'cross-unscoped' })).status).toBe(404);
        expect((await request(app).delete(`/client/api/webhooks/${sameOwnerOtherTenant._id}`)).status).toBe(404);
        expect((await request(app).delete(`/client/api/webhooks/${otherCompany._id}`)).status).toBe(404);
        expect((await request(app).post(`/client/api/webhook-deliveries/${foreignDelivery._id}/retry`)).status).toBe(404);
        expect((await request(app).post(`/client/api/webhook-deliveries/${otherDelivery._id}/retry`)).status).toBe(404);
        expect(axios.post).not.toHaveBeenCalled();
        expect((await MerchantWebhookEndpoint.findById(sameOwnerOtherTenant._id).lean()).name).toBe('own-tenant-b');
        expect(String((await MerchantWebhookEndpoint.findById(sameOwnerOtherTenant._id).lean()).tenantId)).toBe(String(tenantB));
        expect((await MerchantWebhookDelivery.findById(foreignDelivery._id).lean()).status).toBe('failed');
        expect(await snapshot()).toEqual(before);

        const staff = await createCompanyEmployee({
            companyId: companyA,
            tenantId: tenantA,
            role: 'employee',
            canManageCompany: false
        });
        signInCompany(staff);
        expect((await request(app).get('/client/api/webhooks')).status).toBe(403);
        expect((await request(app).get('/client/integrations/webhooks')).status).toBe(403);
        expect((await request(app).patch(`/client/api/webhooks/${ownHere._id}`).send({ name: 'staff-edit' })).status).toBe(422);
        expect((await request(app).delete(`/client/api/webhooks/${ownHere._id}`)).status).toBe(403);
        expect((await request(app).post(`/client/api/webhook-deliveries/${(await createDelivery(ownHere))._id}/retry`)).status).toBe(403);
        expect((await MerchantWebhookEndpoint.findById(ownHere._id).lean()).name).toBe('own-tenant-a');
        expect(axios.post).not.toHaveBeenCalled();

        const operator = await createCompanyEmployee({
            companyId: companyA,
            tenantId: tenantA,
            role: 'employee',
            canManageCompany: true
        });
        signInCompany(operator);
        const allowed = await request(app).get('/client/api/webhooks');
        expect(allowed.status).toBe(200);
        expect(endpointIds(allowed.body)).toEqual([String(ownHere._id)]);

        requestTenantId = null;
        const unscopedEmployee = await createCompanyEmployee({
            companyId: companyA,
            role: 'owner'
        });
        signInCompany(unscopedEmployee);
        expect((await request(app).get('/client/api/webhooks')).status).toBe(403);
        expect(await snapshot()).toEqual(before);
    });

    test('diagnostic powershell here-string matches ahram_webhook_diag.js', () => {
        const doc = fs.readFileSync(path.join(__dirname, '../docs/incidents/merchant-webhooks-visibility.md'), 'utf8');
        const heading = doc.indexOf('## PowerShell: diagnostic');
        const fence = doc.indexOf('```powershell\n', heading);
        const start = fence + '```powershell\n'.length;
        const end = doc.indexOf('\n```', start);
        const block = doc.slice(start, end);
        const open = block.indexOf("@'\n");
        const close = block.indexOf("\n'@", open);
        const embedded = Buffer.from(block.slice(open + 3, close), 'utf8');
        const script = fs.readFileSync(path.join(__dirname, '../docs/incidents/ahram_webhook_diag.js'));
        expect(embedded.equals(script)).toBe(true);
        expect(block).toContain('$env:NODE_PATH');
        expect(block).toContain('$ErrorActionPreference = $prevEAP');
        expect(block).toContain('Remove-Item $scriptPath -Force -ErrorAction SilentlyContinue');
    });

    test('company routes do not use the open admin scope', () => {
        const routeSource = fs.readFileSync(path.join(__dirname, '../routes/merchantWebhooks.js'), 'utf8');
        const clientSection = routeSource.slice(0, routeSource.indexOf("router.get('/admin/webhooks'"));
        expect(clientSection).not.toMatch(/adminAccountScope\(/);
        expect(clientSection).not.toMatch(/tenantScope\(/);
        expect(clientSection).toMatch(/ownerModel: owner\.ownerModel/);
        expect(clientSection).toMatch(/tenantMode\(\) === 'multi'/);
        expect(clientSection).toMatch(/tenantWriteId\(req\)/);
        expect(routeSource).toMatch(/\/admin\/api\/webhooks[\s\S]*adminAccountScope\(req\)/);
    });
});

describe('merchant webhook worker switch', () => {
    test('production with an unset switch stays enabled, and any staging value stays disabled', () => {
        expect(isMerchantWebhookWorkerEnabled({ NODE_ENV: 'production' })).toBe(true);
        expect(isMerchantWebhookWorkerEnabled({
            NODE_ENV: 'production',
            MERCHANT_WEBHOOK_WORKER_ENABLED: 'false'
        })).toBe(false);
        expect(isMerchantWebhookWorkerEnabled({ NODE_ENV: 'staging' })).toBe(false);
        expect(isMerchantWebhookWorkerEnabled({
            NODE_ENV: 'production',
            APP_ENV: 'staging'
        })).toBe(false);
        expect(isMerchantWebhookWorkerEnabled({
            NODE_ENV: 'staging',
            MERCHANT_WEBHOOK_WORKER_ENABLED: 'true'
        })).toBe(true);
    });
});
