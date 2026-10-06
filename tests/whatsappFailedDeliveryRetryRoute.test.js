'use strict';

const path = require('path');
const { once } = require('node:events');
const express = require('express');
const request = require('supertest');

jest.mock('../models/WhatsAppDelivery', () => ({
    find: jest.fn(() => ({
        sort: () => ({
            limit: () => ({ lean: async () => [] })
        })
    })),
    findById: jest.fn(),
    countDocuments: jest.fn(async () => 0)
}));

jest.mock('../services/whatsappService', () => ({
    getWhatChimpTemplateReadiness: jest.fn(async () => ({
        receiptOperational: false,
        missing: [],
        rateChangeOperational: false,
        rateChangeMissing: []
    }))
}));

jest.mock('../services/receiptShareService', () => ({
    getPublicAppUrl: jest.fn(() => 'https://pay.example.test'),
    getReceiptShareSecret: jest.fn(() => 'share-secret')
}));

jest.mock('../services/whatsappReceiptDeliveryService', () => ({
    DELIVERY_STAGE_LABELS: { provider_request: 'إرسال الطلب إلى WhatChimp' },
    sendCompletedTransactionReceipt: jest.fn(),
    sendSplitPartReceipt: jest.fn()
}));

jest.mock('../services/whatsappFailedDeliveryRetryService', () => ({
    STOPPED_STATUS: 'failed',
    countDeliveries: jest.fn(async () => 0),
    previewFailedRetries: jest.fn(),
    retryFailedDeliveries: jest.fn(),
    deliveryFilterForTenant: jest.fn(async (match) => match)
}));

const { retryFailedDeliveries, previewFailedRetries } = require('../services/whatsappFailedDeliveryRetryService');
const csrfProtection = require('../middlewares/csrfProtection');
const router = require('../routes/whatsappMonitoring');

const testServers = new Set();

const buildApp = async (session, { tenantId = null, tenantMode = 'single' } = {}) => {
    process.env.TENANT_MODE = tenantMode;
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'views'));
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = session;
        if (tenantId) {
            req.tenantId = tenantId;
            req.tenant = { _id: tenantId };
        }
        next();
    });
    app.use(csrfProtection);
    app.use('/whatsapp-monitor', router);
    const server = app.listen(0, '127.0.0.1');
    testServers.add(server);
    await once(server, 'listening');
    return server;
};

describe('whatsapp monitor bulk retry route', () => {
    const previousTenantMode = process.env.TENANT_MODE;

    beforeEach(() => {
        jest.clearAllMocks();
        previewFailedRetries.mockResolvedValue({
            window: '72h',
            byKind: { receipt: 2, part_receipt: 1 },
            willAttempt: 3,
            remaining: 0,
            eligible: 3,
            excludedRateChange: true,
            stoppedStatus: 'failed'
        });
        retryFailedDeliveries.mockResolvedValue({
            success: true,
            code: 'BULK_RETRY_COMPLETED',
            window: '72h',
            attempted: 1,
            accepted: [{ id: 'd-1', reference: 'ATT-1', kind: 'receipt', messageId: 'wamid.1' }],
            failedAgain: {},
            skipped: [],
            remaining: 0
        });
    });

    afterEach(async () => {
        await Promise.all([...testServers].map((server) => new Promise((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => error ? reject(error) : resolve());
        })));
        testServers.clear();
    });

    afterAll(() => {
        if (previousTenantMode === undefined) delete process.env.TENANT_MODE;
        else process.env.TENANT_MODE = previousTenantMode;
    });

    const masterSession = () => ({
        isLoggedIn: true,
        adminRole: 'master',
        adminId: 'admin-1',
        adminName: 'ماي',
        csrfToken: 'csrf-token'
    });

    test('renders the bulk retry button and confirmation copy for a master admin', async () => {
        const response = await request(await buildApp(masterSession()))
            .get('/whatsapp-monitor')
            .expect(200);

        expect(response.text).toContain('إعادة محاولة الرسائل غير الناجحة');
        expect(response.text).toContain('إشعارات تغيير السعر غير مشمولة');
        expect(response.text).toContain('إذا لم يُعالج سبب الفشل فقد تفشل هذه الرسائل مرة أخرى');
        expect(response.text).toContain('name="_csrf"');
        expect(response.text).toContain('value="72h" selected');
    });

    test('hides the bulk retry button from an admin who is not master', async () => {
        const response = await request(await buildApp({
            isLoggedIn: true,
            adminRole: 'admin',
            adminPermissions: ['support.manage'],
            adminId: 'admin-2',
            adminName: 'مشرف',
            csrfToken: 'csrf-token'
        })).get('/whatsapp-monitor').expect(200);

        expect(response.text).not.toContain('إعادة محاولة الرسائل غير الناجحة');
        expect(response.text).not.toContain('id="bulkRetryModal"');
        expect(response.text).not.toContain('/whatsapp-monitor/failed-retries');
    });

    test('rejects a bulk retry without a CSRF token', async () => {
        const response = await request(await buildApp(masterSession()))
            .post('/whatsapp-monitor/failed-retries')
            .set('Accept', 'application/json')
            .send({ window: '72h' });

        expect(response.status).toBe(403);
        expect(response.body.error).toMatch(/CSRF/i);
        expect(retryFailedDeliveries).not.toHaveBeenCalled();
    });

    test('denies a non-master admin even with support.manage', async () => {
        const response = await request(await buildApp({
            isLoggedIn: true,
            adminRole: 'admin',
            adminPermissions: ['support.manage'],
            adminId: 'admin-2',
            adminName: 'مشرف',
            csrfToken: 'csrf-token'
        }))
            .post('/whatsapp-monitor/failed-retries')
            .set('Accept', 'application/json')
            .send({ _csrf: 'csrf-token', window: '72h' });

        expect(response.status).toBe(403);
        expect(retryFailedDeliveries).not.toHaveBeenCalled();
    });

    test('runs the retry inside the current tenant scope for a master admin', async () => {
        const response = await request(await buildApp(masterSession(), { tenantId: 'tenant-a', tenantMode: 'multi' }))
            .post('/whatsapp-monitor/failed-retries')
            .set('Accept', 'application/json')
            .send({ _csrf: 'csrf-token', window: '24h' });

        expect(response.status).toBe(200);
        expect(response.body.attempted).toBe(1);
        expect(response.body.accepted[0].messageId).toBe('wamid.1');
        expect(retryFailedDeliveries).toHaveBeenCalledWith(expect.objectContaining({
            window: '24h',
            tenantFilter: { tenantId: 'tenant-a' },
            actor: expect.objectContaining({ id: 'admin-1', name: 'ماي' })
        }));
    });

    test('requires a master admin to preview the eligible count', async () => {
        const denied = await request(await buildApp({
            isLoggedIn: true,
            adminRole: 'admin',
            adminPermissions: ['support.read', 'support.manage'],
            csrfToken: 'csrf-token'
        }))
            .get('/whatsapp-monitor/failed-retries/preview?window=72h')
            .set('Accept', 'application/json');

        expect(denied.status).toBe(403);
        expect(previewFailedRetries).not.toHaveBeenCalled();

        const allowed = await request(await buildApp(masterSession(), { tenantId: 'tenant-a', tenantMode: 'multi' }))
            .get('/whatsapp-monitor/failed-retries/preview?window=72h')
            .set('Accept', 'application/json');

        expect(allowed.status).toBe(200);
        expect(allowed.body.byKind).toEqual({ receipt: 2, part_receipt: 1 });
        expect(previewFailedRetries).toHaveBeenCalledWith({
            tenantFilter: { tenantId: 'tenant-a' },
            window: '72h'
        });
    });
});
