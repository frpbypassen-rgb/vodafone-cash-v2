'use strict';
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('dns', () => ({
    promises: { lookup: jest.fn(async () => [{ address: '203.0.113.10', family: 4 }]) },
}));
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Company = require('../models/ClientCompany');
const User = require('../models/User');
const service = require('../services/merchantIntegrationService');
const Endpoint = require('../models/MerchantWebhookEndpoint');
const Delivery = require('../models/MerchantWebhookDelivery');
const { encrypt } = require('../utils/encryption');
const { deliverWebhook, enqueueTransactionWebhook } = require('../services/merchantWebhookService');
const axios = require('axios');
let mongo, app;
beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    app = express();
    app.use(express.json());
    app.use('/merchant', require('../routes/merchantApi'));
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});
afterEach(async () => {
    await Promise.all([
        Company.deleteMany({}),
        User.deleteMany({}),
        Endpoint.deleteMany({}),
        Delivery.deleteMany({}),
    ]);
});
for (const kind of ['company', 'agent']) {
    test(`${kind}: admin gating, rotation and revocation control real API authentication`, async () => {
        const Model = kind === 'company' ? Company : User;
        const entity = await Model.create(
            kind === 'company'
                ? { name: 'Demo', token: 'legacy-key' }
                : {
                      name: 'Demo',
                      role: 'agent',
                      webUsername: 'demo',
                      webPassword: 'demo-password',
                      apiToken: 'legacy-key',
                  }
        );
        const workspace = {
            isCompany: kind === 'company',
            isAgent: kind === 'agent',
            entity,
            entityModel: kind === 'company' ? 'ClientCompany' : 'User',
            permissions: { owner: true },
        };
        expect((await request(app).get('/merchant/balance').set('x-api-key', 'legacy-key')).status).toBe(401);
        await service.setAdminAccess(Model, { _id: entity._id }, { apiEnabled: true, webhooksEnabled: true });
        expect((await request(app).get('/merchant/balance').set('x-api-key', 'legacy-key')).status).toBe(200);
        const first = await service.rotateKey(workspace);
        expect(first.token).toMatch(/^ahr_[a-f0-9]{64}$/);
        expect(JSON.stringify(await service.getStatus(workspace))).not.toContain(first.token);
        expect((await request(app).get('/merchant/balance').set('x-api-key', 'legacy-key')).status).toBe(401);
        expect((await request(app).get('/merchant/balance').set('x-api-key', first.token)).status).toBe(200);
        const second = await service.rotateKey(workspace);
        expect((await request(app).get('/merchant/balance').set('x-api-key', first.token)).status).toBe(401);
        expect((await request(app).get('/merchant/balance').set('x-api-key', second.token)).status).toBe(200);
        const stored = await Model.findById(entity._id).select('+merchantApiKeyHash +apiToken').lean();
        expect(stored.token || stored.apiToken).toBeUndefined();
        expect(stored.merchantApiKeyHash).not.toBe(second.token);
        await service.setAdminAccess(
            Model,
            { _id: entity._id },
            { apiEnabled: false, webhooksEnabled: false }
        );
        await expect(service.rotateKey(workspace)).rejects.toMatchObject({ statusCode: 403 });
        expect((await request(app).get('/merchant/balance').set('x-api-key', second.token)).status).toBe(401);
        await service.setAdminAccess(Model, { _id: entity._id }, { apiEnabled: true, webhooksEnabled: true });
        await service.revokeKey(workspace);
        expect((await request(app).get('/merchant/balance').set('x-api-key', second.token)).status).toBe(401);
        await service.setAdminAccess(
            Model,
            { _id: entity._id },
            { apiEnabled: false, webhooksEnabled: false }
        );
        await service.setAdminAccess(Model, { _id: entity._id }, { apiEnabled: true, webhooksEnabled: true });
        expect((await request(app).get('/merchant/balance').set('x-api-key', second.token)).status).toBe(401);
        const concurrent = await Promise.all([service.rotateKey(workspace), service.rotateKey(workspace)]);
        const statuses = await Promise.all(
            concurrent.map(
                async (result) =>
                    (await request(app).get('/merchant/balance').set('x-api-key', result.token)).status
            )
        );
        expect(statuses.sort()).toEqual([200, 401]);
        await Model.updateOne({ _id: entity._id }, { $set: { status: 'inactive' } });
        await service.revokeKey(workspace);
        await Model.updateOne({ _id: entity._id }, { $set: { status: 'active' } });
        for (const issued of concurrent)
            expect((await request(app).get('/merchant/balance').set('x-api-key', issued.token)).status).toBe(401);
    });
}
for (const kind of ['company', 'agent']) {
    test(`${kind}: admin disables queued webhook delivery and enqueuing; reactivation permits delivery`, async () => {
        const saved = process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
        process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = 'true';
        axios.post.mockClear();
        axios.post.mockResolvedValue({ status: 200, data: 'ok' });
        try {
            const Model = kind === 'company' ? Company : User;
            const entity = await Model.create(
                kind === 'company'
                    ? { name: 'Hooks' }
                    : { role: 'agent', webUsername: 'hooks', webPassword: 'hooks-password' }
            );
            const owner = { ownerId: entity._id, ownerModel: kind === 'company' ? 'ClientCompany' : 'User' };
            const endpoint = await Endpoint.create({
                ...owner,
                url: 'https://hooks.example.test/receive',
                enabled: true,
                events: ['transfer.completed'],
                secretEncrypted: encrypt('test-signature-secret'),
            });
            const fields = {
                ...owner,
                endpointId: endpoint._id,
                eventType: 'transfer.completed',
                payload: { type: 'transfer.completed' },
            };
            await service.setAdminAccess(
                Model,
                { _id: entity._id },
                { apiEnabled: false, webhooksEnabled: true }
            );
            const queued = await Delivery.create({ ...fields, eventId: 'before-disable' });
            await service.setAdminAccess(
                Model,
                { _id: entity._id },
                { apiEnabled: false, webhooksEnabled: false }
            );
            expect(await deliverWebhook(queued._id)).toMatchObject({
                delivered: false,
                reason: 'WEBHOOK_DISABLED_BY_ADMIN',
            });
            const transaction = {
                _id: new mongoose.Types.ObjectId(),
                status: 'completed',
                ...(kind === 'company'
                    ? { companyId: entity._id }
                    : { clientActorId: entity._id, clientActorModel: 'User' }),
            };
            expect(await enqueueTransactionWebhook('transfer.completed', transaction)).toEqual([]);
            expect(axios.post).not.toHaveBeenCalled();
            await service.setAdminAccess(
                Model,
                { _id: entity._id },
                { apiEnabled: false, webhooksEnabled: true }
            );
            const next = await Delivery.create({ ...fields, eventId: 'after-enable' });
            expect(await deliverWebhook(next._id)).toMatchObject({ delivered: true });
            expect(axios.post).toHaveBeenCalledTimes(1);
            const pinnedLookup = axios.post.mock.calls[0][2].httpsAgent.options.lookup;
            const resolved = jest.fn();
            pinnedLookup('hooks.example.test', {}, resolved);
            expect(resolved).toHaveBeenCalledWith(null, '203.0.113.10', 4);
            expect(axios.post.mock.calls[0][2].proxy).toBe(false);
            expect(axios.post.mock.calls[0][2].headers['x-ahrampay-signature']).toMatch(
                /^sha256=[a-f0-9]{64}$/
            );
        } finally {
            if (saved === undefined) delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
            else process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = saved;
        }
    });
}
test('non-owner cannot obtain or mutate integration credentials', async () => {
    const workspace = { isCompany: true, permissions: { owner: false, manager: true } };
    await expect(service.getStatus(workspace)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.rotateKey(workspace)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.revokeKey(workspace)).rejects.toMatchObject({ statusCode: 403 });
});
