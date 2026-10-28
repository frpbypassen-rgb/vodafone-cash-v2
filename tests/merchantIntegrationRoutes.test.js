'use strict';
jest.mock('../services/auditService', () => ({ logAction: jest.fn(async () => {}) }));
jest.mock('dns', () => ({
    promises: { lookup: jest.fn(async () => [{ address: '203.0.113.10', family: 4 }]) },
}));
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Company = require('../models/ClientCompany');
const Employee = require('../models/ClientEmployee');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Endpoint = require('../models/MerchantWebhookEndpoint');
const { logAction } = require('../services/auditService');
const csrf = 'integration-test-csrf-token';
let mongo, app, session, tenant;
beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    app = express();
    app.set('view engine', 'ejs');
    app.set('views', require('path').join(__dirname, '../views'));
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
        req.session = session;
        req.tenant = tenant ? { _id: tenant } : null;
        req.tenantId = tenant;
        next();
    });
    app.use(require('../middlewares/csrfProtection'));
    app.use(require('../routes/merchantIntegrations'));
    app.use(require('../routes/merchantWebhooks'));
    app.use('/api/v1/merchant', require('../routes/merchantApi'));
});
beforeEach(() => {
    session = { csrfToken: csrf, destroy: (cb) => cb() };
    tenant = null;
    jest.clearAllMocks();
});
afterEach(async () => {
    await Promise.all([
        Company.deleteMany({}),
        Employee.deleteMany({}),
        User.deleteMany({}),
        Endpoint.deleteMany({}),
        Transaction.deleteMany({}),
    ]);
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});
const post = (url, body) =>
    request(app).post(url).set('Accept', 'application/json').set('X-CSRF-Token', csrf).send(body);
for (const kind of ['company', 'agent']) {
    test(`${kind}: actual admin and portal routes enforce flags, password, CSRF and revocation`, async () => {
        const isCompany = kind === 'company';
        const entity = await (isCompany ? Company : User).create(
            isCompany
                ? { name: 'Company' }
                : { name: 'Agency', role: 'agent', webUsername: 'owner', webPassword: 'test-password-123' }
        );
        const actor = isCompany
            ? await Employee.create({
                  name: 'Owner',
                  companyId: entity._id,
                  role: 'owner',
                  webUsername: 'owner',
                  webPassword: 'test-password-123',
              })
            : entity;
        const base = isCompany ? '/client' : '/agent-portal';
        const adminPath = `${isCompany ? '/company/' : '/user/'}${entity._id}/integrations`;
        const ownerSession = {
            ...session,
            isClientLoggedIn: true,
            clientId: actor._id,
            accountType: isCompany ? 'company' : 'user',
        };
        session = ownerSession;
        const lockedPage = await request(app).get(base + '/integrations/api');
        expect(lockedPage.status).toBe(200);
        expect(lockedPage.headers['cache-control']).toContain('no-store');
        expect(lockedPage.text).toContain('merchant-api-page.js');
        expect(
            (
                await request(app)
                    .get(base + '/api/integrations')
                    .set('Accept', 'application/json')
            ).body.data.apiEnabled
        ).toBe(false);
        expect(
            (await post(base + '/api/integrations/rotate', { currentPassword: 'test-password-123' })).status
        ).toBe(403);
        expect((await post(adminPath, { apiEnabled: 'on' })).status).toBe(401);
        session = { ...session, isLoggedIn: true, adminRole: 'accountant' };
        expect((await post(adminPath, { apiEnabled: 'on' })).status).toBe(403);
        session = { csrfToken: csrf, isLoggedIn: true, adminRole: 'master' };
        expect((await post(adminPath, { apiEnabled: 'on', webhooksEnabled: 'on', revision: (await (isCompany ? Company : User).findById(entity._id)).integrationAccess.revision || 0 })).status).toBe(302);
        session = ownerSession;
        expect((await post(base + '/api/integrations/rotate', { currentPassword: 'wrong' })).status).toBe(
            400
        );
        expect(
            (
                await request(app)
                    .post(base + '/api/integrations/rotate')
                    .send({ currentPassword: 'test-password-123' })
            ).status
        ).toBe(403);
        const created = await post(base + '/api/integrations/rotate', {
            currentPassword: 'test-password-123',
        });
        expect(created.status).toBe(200);
        expect(created.headers['cache-control']).toContain('no-store');
        const token = created.body.data.token;
        const readBalance = (key) => request(app).get('/api/v1/merchant/balance').set('x-api-key', key);
        expect((await readBalance(token)).status).toBe(200);
        const rotated = await post(base + '/api/integrations/rotate', {
            currentPassword: 'test-password-123',
        });
        expect(rotated.status).toBe(200);
        expect((await readBalance(token)).status).toBe(401);
        expect((await readBalance(rotated.body.data.token)).status).toBe(200);
        await Transaction.create([
            { customId: `${kind}-api-own`, companyId: isCompany ? entity._id : undefined,
              clientActorId: String(entity._id), clientActorModel: isCompany ? 'ClientCompany' : 'User',
              employeeName: 'ربط آلي (Merchant API)', userId: isCompany ? 'api_merchant' : String(entity._id), amount: 123, status: 'completed' },
            { customId: `${kind}-api-other`, companyId: new mongoose.Types.ObjectId(),
              clientActorId: String(new mongoose.Types.ObjectId()), clientActorModel: isCompany ? 'ClientCompany' : 'User',
              employeeName: 'ربط آلي (Merchant API)', amount: 999 },
            { customId: `${kind}-portal-own`, companyId: isCompany ? entity._id : undefined,
              clientActorId: String(entity._id), clientActorModel: isCompany ? 'ClientCompany' : 'User',
              employeeName: 'موظف البوابة', amount: 222 }
        ]);
        const activity = await request(app).get(base + '/api/integrations/activity').set('Accept','application/json');
        expect(activity.status).toBe(200);
        expect(activity.body.data.rows.map(row => row.reference)).toEqual([`${kind}-api-own`]);
        expect(activity.body.data.rows[0]).not.toHaveProperty('amount');
        expect(activity.text).not.toContain(rotated.body.data.token);
        const hook = await post(base + '/api/webhooks', {
            name: 'Hook',
            url: 'https://hooks.example.test/events',
            events: ['transfer.completed'],
        });
        expect(hook.status).toBe(201);
        const list = await request(app)
            .get(base + '/api/webhooks')
            .set('Accept', 'application/json');
        expect(list.status).toBe(200);
        expect(JSON.stringify(list.body)).not.toContain(hook.body.secret);
        session = { csrfToken: csrf, isLoggedIn: true, adminRole: 'master' };
        expect((await post(adminPath, { revision: (await (isCompany ? Company : User).findById(entity._id)).integrationAccess.revision || 0 })).status).toBe(302);
        expect((await readBalance(rotated.body.data.token)).status).toBe(401);
        session = ownerSession;
        expect(
            (
                await request(app)
                    .get(base + '/api/webhooks')
                    .set('Accept', 'application/json')
            ).status
        ).toBe(403);
        expect((await post(base + '/api/webhooks/' + hook.body.endpoint.id + '/test', {})).status).toBe(403);
        expect(
            (await post(base + '/api/integrations/revoke', { currentPassword: 'test-password-123' })).status
        ).toBe(200);
        session = { csrfToken: csrf, isLoggedIn: true, adminRole: 'master' };
        expect((await post(adminPath, { apiEnabled: 'on', webhooksEnabled: 'on', revision: (await (isCompany ? Company : User).findById(entity._id)).integrationAccess.revision || 0 })).status).toBe(302);
        expect((await readBalance(rotated.body.data.token)).status).toBe(401);
        const auditEntries = logAction.mock.calls.map(([entry]) => ({
            action: entry.action,
            metadata: entry.metadata,
        }));
        expect(JSON.stringify(auditEntries)).not.toContain(token);
        expect(JSON.stringify(auditEntries)).not.toContain('test-password-123');
    });
}
test('an operational manager cannot administer integration credentials', async () => {
    const company = await Company.create({ name: 'Company' });
    const employee = await Employee.create({
        name: 'Manager',
        companyId: company._id,
        role: 'employee',
        canManageCompany: true,
        webUsername: 'manager',
        webPassword: 'test-password-123',
    });
    session = { ...session, isClientLoggedIn: true, accountType: 'company', clientId: employee._id };
    expect(
        (await request(app).get('/client/api/integrations').set('Accept', 'application/json')).status
    ).toBe(403);
    expect(
        (await post('/client/api/integrations/rotate', { currentPassword: 'test-password-123' })).status
    ).toBe(403);
    expect((await request(app).get('/client/integrations/api')).status).toBe(403);
    expect((await request(app).get('/client/api/integrations/activity').set('Accept','application/json')).status).toBe(403);
});
test('integration management rejects a company session from another tenant', async () => {
    const saved = process.env.TENANT_MODE;
    process.env.TENANT_MODE = 'multi';
    try {
        tenant = new mongoose.Types.ObjectId();
        const company = await Company.create({ name: 'Other', tenantId: new mongoose.Types.ObjectId() });
        const owner = await Employee.create({
            name: 'Owner',
            companyId: company._id,
            tenantId: company.tenantId,
            role: 'owner',
            webUsername: 'owner',
            webPassword: 'test-password-123',
        });
        session = { ...session, isClientLoggedIn: true, accountType: 'company', clientId: owner._id };
        expect(
            (await request(app).get('/client/api/integrations').set('Accept', 'application/json')).status
        ).toBe(403);
        expect((await request(app).get('/client/integrations/api')).status).toBe(403);
        expect((await request(app).get('/client/api/integrations/activity').set('Accept','application/json')).status).toBe(403);
        session = { csrfToken: csrf, isLoggedIn: true, adminRole: 'master' };
        expect((await post('/company/' + company._id + '/integrations', { apiEnabled: 'on', revision: 0 })).status).toBe(
            404
        );
        tenant = null;
        expect((await post('/company/' + company._id + '/integrations', { apiEnabled: 'on' })).status).toBe(
            403
        );
        expect((await Company.findById(company._id).lean()).integrationAccess.apiEnabled).toBe(false);
    } finally {
        if (saved === undefined) delete process.env.TENANT_MODE;
        else process.env.TENANT_MODE = saved;
    }
});
