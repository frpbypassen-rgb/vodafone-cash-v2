'use strict';
jest.mock('web-push', () => ({ sendNotification: jest.fn().mockResolvedValue({ statusCode: 201 }) }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createECDH } = require('crypto');
const express = require('express');
const request = require('supertest');
const webpush = require('web-push');
const Transaction = require('../models/Transaction');
const Admin = require('../models/Admin');
const { AdminOperationAlert: Alert, AdminAlertState: State, AdminPushDevice: Device, AdminPushDelivery: Delivery } = require('../models/AdminOperationAlert');
const service = require('../services/adminOperationAlertService');
const router = require('../routes/adminOperationAlerts');
const csrf = require('../middlewares/csrfProtection');
const { accountantPathAllowed } = require('../config/adminRoles');
const id = () => new mongoose.Types.ObjectId();
const curve = createECDH('prime256v1'); curve.generateKeys();
const subscription = (token = 'one') => ({ endpoint: `https://fcm.googleapis.com/wp/${token}`,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } });
const tx = (overrides = {}) => ({ _id: id(), customId: `TEST-${id()}`, amount: 100, costLYD: 15, status: 'pending',
    createdAt: new Date(), updatedAt: new Date(), transferType: 'vodafone', ...overrides });
const held = overrides => tx({ status: 'processing', apiResultData: { providerResultUnresolved: true }, ...overrides });
const actor = { id: 'master_admin', name: 'مدير التجربة', role: 'master' };
const register = (overrides = {}) => service.registerDevice({ actor, subscription: subscription(), allTenants: true, sessionVersion: 0, sessionId: 'test-session', ...overrides });
describe('admin operational alerts: isolated financial reads and durable notification state', () => {
    let server;
    const originalEnv = { ...process.env };
    beforeAll(async () => {
        server = await MongoMemoryServer.create();
        await mongoose.connect(server.getUri(), { dbName: 'admin_alerts_tests' });
        await Promise.all([Alert, State, Device, Delivery, Transaction, Admin].map(model => model.init()));
    }, 60000);
    afterAll(async () => { process.env = originalEnv; await mongoose.disconnect(); await server.stop(); });
    beforeEach(async () => {
        await Promise.all([Alert, State, Device, Delivery, Transaction, Admin].map(model => model.deleteMany({})));
        jest.clearAllMocks(); webpush.sendNotification.mockResolvedValue({ statusCode: 201 });
        process.env.WEB_PUSH_PUBLIC_KEY = 'test-public'; process.env.WEB_PUSH_PRIVATE_KEY = 'test-private';
        process.env.TENANT_MODE = 'single';
    });
    test('startup skips historical new-operation noise, detects API holds, and repeated scans never write financial records', async () => {
        const now = new Date();
        const old = held({ createdAt: new Date(now.getTime() - 86400000) });
        await Transaction.collection.insertOne(old);
        await service.scanAlerts(now);
        const fresh = tx({ createdAt: new Date(now.getTime() + 1) });
        const deposit = tx({ status: 'deposit', createdAt: fresh.createdAt });
        const internal = tx({ transferType: 'balance_transfer', createdAt: fresh.createdAt });
        await Transaction.collection.insertMany([fresh, deposit, internal]);
        const before = await Transaction.find().lean();
        await service.scanAlerts(new Date(now.getTime() + 1000));
        await service.scanAlerts(new Date(now.getTime() + 2000));
        expect(await Alert.countDocuments({ kind: 'new_operation' })).toBe(1);
        expect(await Alert.countDocuments({ kind: 'api_pending' })).toBe(1);
        expect(await Transaction.find().lean()).toEqual(before);
    });
    test('paginated new-operation scan retains all events across batches', async () => {
        const now = new Date(); await service.scanAlerts(now);
        const date = new Date(now.getTime() + 1);
        await Transaction.collection.insertMany(Array.from({ length: 205 }, () => tx({ createdAt: date })));
        await service.scanAlerts(new Date(now.getTime() + 1000));
        await service.scanAlerts(new Date(now.getTime() + 2000));
        await service.scanAlerts(new Date(now.getTime() + 3000));
        expect(await Alert.countDocuments({ kind: 'new_operation' })).toBe(205);
    });
    test('one atomic owner wins concurrent acknowledgements, with tenant isolation and no financial changes', async () => {
        const tenantId = id(), operation = held({ tenantId }); await Transaction.collection.insertOne(operation);
        await service.recordAlert(operation, 'api_pending');
        const eventId = `api_pending:${operation._id}`;
        expect(await service.acknowledge({ id: eventId, scope: { tenantId: id() }, actor })).toBeNull();
        const before = await Transaction.find().lean();
        const [a, b] = await Promise.all([
            service.acknowledge({ id: eventId, scope: { tenantId }, actor }),
            service.acknowledge({ id: eventId, scope: { tenantId }, actor: { id: 'second', name: 'موظف آخر' } })
        ]);
        expect(a.acknowledgedName).toBe(b.acknowledgedName);
        expect((await Alert.findById(eventId)).acknowledgedBy).toBeTruthy();
        expect(await Transaction.find().lean()).toEqual(before);
    });
    test('terminal and paid scheduled-completion rows cannot become provider hold alarms', async () => {
        expect(service.providerPending(held({ status: 'completed' }))).toBe(false);
        expect(service.providerPending(held({ apiResultData: { waitingApiAutoCompletion: true, referenceMasked: true } }))).toBe(false);
        expect(service.providerPending(held({ apiResultData: { providerResolutionOutcome: 'cancelled', providerResultUnresolved: true } }))).toBe(false);
        expect(service.providerPending(held({ apiResultData: { referenceNumber: '01012345678', referenceMasked: false } }))).toBe(true);
        const operation = held({ status: 'completed' }); await Transaction.collection.insertOne(operation);
        await service.recordAlert(operation, 'api_pending');
        const result = await service.acknowledge({ id: `api_pending:${operation._id}`, scope: {}, actor });
        expect(result.resolvedAt).toBeTruthy(); expect(result.acknowledgedAt).toBeUndefined();
    });
    test('push deliveries are deduplicated per device and omit balances and phone numbers', async () => {
        await register(); const operation = tx({ vodafoneNumber: '01012345678' });
        await Transaction.collection.insertOne(operation); await service.recordAlert(operation, 'new_operation');
        const before = await Transaction.find().lean();
        await service.queuePush(); await service.queuePush();
        expect(await Delivery.countDocuments()).toBe(1);
        await Promise.all([service.deliverPush(), service.deliverPush()]);
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(webpush.sendNotification.mock.calls[0][1]);
        expect(payload).not.toHaveProperty('amount'); expect(JSON.stringify(payload)).not.toContain(operation.vodafoneNumber);
        expect(await Transaction.find().lean()).toEqual(before);
    });
    test('retries are bounded and expired device subscriptions are disabled', async () => {
        const deviceId = await register(); const operation = tx(); await service.recordAlert(operation, 'new_operation'); await service.queuePush();
        webpush.sendNotification.mockRejectedValue(Object.assign(new Error('expired'), { statusCode: 410 }));
        await service.deliverPush(); await service.deliverPush();
        expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
        expect((await Device.findById(deviceId)).active).toBe(false);
        expect((await Delivery.findOne()).status).toBe('failed');
    });
    test('retryable failures stop at three attempts without modifying the operation', async () => {
        await register(); const operation = tx(); await Transaction.collection.insertOne(operation);
        await service.recordAlert(operation, 'new_operation'); await service.queuePush();
        webpush.sendNotification.mockRejectedValue(new Error('network'));
        for (let i = 0; i < 4; i++) {
            await Delivery.updateMany({}, { $set: { nextAttemptAt: new Date(0), leaseUntil: null } });
            await service.deliverPush();
        }
        expect(webpush.sendNotification).toHaveBeenCalledTimes(3);
        expect((await Delivery.findOne()).status).toBe('failed');
        expect((await Transaction.findById(operation._id)).status).toBe('pending');
    });
    test('resolved or acknowledged holds do not send late alarms', async () => {
        await register(); const operation = held(); await Transaction.collection.insertOne(operation);
        await service.recordAlert(operation, 'api_pending'); await service.queuePush();
        await service.acknowledge({ id: `api_pending:${operation._id}`, scope: {}, actor }); await service.deliverPush();
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });
    test('suspended admins, changed session versions, wrong tenants and reassigned devices cannot receive queued alerts', async () => {
        const adminId = id(), tenantId = id();
        await Admin.collection.insertOne({ _id: adminId, status: 'active', role: 'admin', permissions: ['transactions.read'], sessionVersion: 1, webUsername: 'test' });
        await register({ actor: { id: String(adminId) }, sessionVersion: 1, tenantId, allTenants: false });
        const operation = tx({ tenantId: id() }); await service.recordAlert(operation, 'new_operation'); await service.queuePush();
        expect(await Delivery.countDocuments()).toBe(0);
        await service.recordAlert(tx({ tenantId }), 'new_operation'); await service.queuePush();
        expect(await Delivery.countDocuments()).toBe(1);
        await Admin.updateOne({ _id: adminId }, { $set: { sessionVersion: 2 } });
        await service.deliverPush(); expect(webpush.sendNotification).not.toHaveBeenCalled();
        await register({ actor, sessionId: 'another-session' });
        expect(await service.disableSessionDevices(actor.id, 'test-session')).toMatchObject({ modifiedCount: 0 });
        await service.disableSessionDevices(actor.id, 'another-session'); expect((await Device.findOne()).active).toBe(false);
    });
    test('malformed or unsafe push endpoints are rejected without network access', async () => {
        await expect(register({ subscription: { ...subscription(), endpoint: 'http://127.0.0.1/private' } })).rejects.toThrow();
        expect(await Device.countDocuments()).toBe(0); expect(webpush.sendNotification).not.toHaveBeenCalled();
    });
    test('HTTP authentication, CSRF and tenant boundaries protect acknowledgement and subscriptions', async () => {
        const tenantId = id(), operation = held({ tenantId }); await Transaction.collection.insertOne(operation);
        await service.recordAlert(operation, 'api_pending');
        const app = (session, tenant = tenantId) => {
            const instance = express(); instance.use(express.json());
            instance.use((req, res, next) => { req.session = session; req.sessionID = 'test-session'; req.tenantId = tenant; next(); });
            instance.use(csrf); instance.use('/api/admin-operation-alerts', router); return instance;
        };
        const path = `/api/admin-operation-alerts/acknowledge/${operation._id}`;
        const session = { isLoggedIn: true, adminId: 'master_admin', adminRole: 'master', adminName: actor.name, csrfToken: 'test-csrf' };
        expect((await request(app({})).get('/api/admin-operation-alerts')).status).toBe(401);
        expect((await request(app(session)).post(path).send({})).status).toBe(403);
        process.env.TENANT_MODE = 'multi';
        expect((await request(app(session, id())).post(path).set('x-csrf-token', 'test-csrf').send({})).status).toBe(404);
        expect((await request(app(session)).post(path).set('x-csrf-token', 'test-csrf').send({})).status).toBe(200);
        expect(accountantPathAllowed('POST', path)).toBe(true);
        expect(accountantPathAllowed('POST', '/transaction/123/cancel')).toBe(false);
    });
});
