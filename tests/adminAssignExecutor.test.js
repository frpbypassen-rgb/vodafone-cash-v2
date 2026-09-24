'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../middlewares/auth', () => ({
    requireAuth: (req, _res, next) => next()
}));

jest.mock('../models/Transaction', () => ({
    findOne: jest.fn(),
    collection: { updateOne: jest.fn() }
}));

jest.mock('../models/ExecutorGroup', () => ({
    findOne: jest.fn(),
    find: jest.fn()
}));

jest.mock('../models/Ledger', () => ({}));
jest.mock('../models/ClientCompany', () => ({}));
jest.mock('../models/Employee', () => ({}));
jest.mock('../models/ClientEmployee', () => ({}));
jest.mock('../models/Admin', () => ({}));
jest.mock('../models/Notification', () => ({}));
jest.mock('../models/SupportTicket', () => ({}));

jest.mock('../services/bullQueueService', () => ({
    addTransferJob: jest.fn().mockResolvedValue(undefined),
    initBullMQ: jest.fn().mockReturnValue(false)
}));

jest.mock('../services/queueService', () => ({
    addJob: jest.fn().mockResolvedValue(undefined),
    processSingleJob: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/eventBus', () => ({
    publish: jest.fn()
}));

jest.mock('../services/externalApiService', () => ({
    getApiProviderBalance: jest.fn(),
    executeTransferViaApi: jest.fn(),
    saveApiReceiptProof: jest.fn()
}));

jest.mock('../services/auditService', () => ({
    logAction: jest.fn()
}));

const Transaction = require('../models/Transaction');
const { logAction } = require('../services/auditService');
const ExecutorGroup = require('../models/ExecutorGroup');
const { addTransferJob } = require('../services/bullQueueService');
const queueService = require('../services/queueService');
const eventBus = require('../services/eventBus');
const { executeTransferViaApi } = require('../services/externalApiService');
const adminTransactions = require('../routes/adminTransactions');

const buildApp = (session) => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
        req.session = session || {
            isLoggedIn: true,
            adminId: 'admin-1',
            adminName: 'مدير',
            tenantId: 'current-tenant'
        };
        req.tenantId = 'current-tenant';
        req.tenant = { _id: 'current-tenant' };
        next();
    });
    app.use(adminTransactions);
    return app;
};

const pendingTx = {
    _id: 'tx-api-1',
    customId: 'ATT-2609-0001',
    status: 'pending',
    transferType: 'vodafone',
    amount: 100,
    toObject() {
        return {
            _id: this._id,
            customId: this.customId,
            status: this.status,
            transferType: this.transferType,
            amount: this.amount
        };
    }
};

describe('admin assign-executor API dispatch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Transaction.findOne.mockResolvedValue(pendingTx);
        Transaction.collection.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
        addTransferJob.mockResolvedValue(undefined);
        queueService.addJob.mockResolvedValue(undefined);
    });

    test('routes an API executor with a historical tenant id and queues provider dispatch', async () => {
        const apiExecutor = {
            _id: 'api-group-historical',
            name: 'بوابة ZaynPay الآلية',
            status: 'active',
            isApiBot: true,
            isApiGroup: true,
            isManagerBot: false,
            serviceKey: 'vodafone',
            tenantId: 'legacy-tenant'
        };
        ExecutorGroup.findOne.mockResolvedValue(apiExecutor);

        const response = await request(buildApp())
            .post('/transaction/tx-api-1/assign-executor')
            .set('Accept', 'application/json')
            .set('x-requested-with', 'XMLHttpRequest')
            .send({ executorGroupId: 'api-group-historical' });

        expect(ExecutorGroup.findOne).toHaveBeenCalledWith({ _id: 'api-group-historical' });
        expect(Transaction.collection.updateOne).toHaveBeenCalledWith(
            { _id: 'tx-api-1', status: 'pending' },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: 'processing',
                    executorGroupId: 'api-group-historical',
                    executorName: 'بوابة ZaynPay الآلية',
                    routedByAdminId: 'admin-1',
                    routedByAdminName: 'مدير'
                })
            })
        );
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'TRANSACTION_ROUTED',
            performedById: 'admin-1',
            performedByName: 'مدير',
            performedByModel: 'Admin',
            required: true
        }));
        expect(addTransferJob).toHaveBeenCalledWith('tx-api-1', 'api-group-historical');
        expect(executeTransferViaApi).not.toHaveBeenCalled();
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            message: 'تم توجيه العملية إلى منفذ API.',
            transaction: { id: 'tx-api-1', status: 'processing' }
        });
        expect(eventBus.publish).toHaveBeenCalledWith(
            'executor:task-available',
            expect.objectContaining({ source: 'admin-api-route' })
        );
    });

    test('falls back to in-process API queue when BullMQ enqueue throws', async () => {
        ExecutorGroup.findOne.mockResolvedValue({
            _id: 'api-group-1',
            name: 'منفذ API',
            status: 'active',
            isApiBot: true,
            isManagerBot: false,
            serviceKey: 'vodafone'
        });
        addTransferJob.mockRejectedValue(new Error('REDIS_LOCK_FAILED'));

        const response = await request(buildApp())
            .post('/transaction/tx-api-1/assign-executor')
            .set('Accept', 'application/json')
            .set('x-requested-with', 'XMLHttpRequest')
            .send({ executorBotId: 'api-group-1' });

        expect(addTransferJob).toHaveBeenCalledWith('tx-api-1', 'api-group-1');
        expect(queueService.addJob).toHaveBeenCalledWith('tx-api-1', 'api-group-1');
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.transaction.status).toBe('processing');
    });

    test('does not queue an API job when routing to a human executor', async () => {
        ExecutorGroup.findOne.mockResolvedValue({
            _id: 'human-group-1',
            name: 'منفذ بشري',
            status: 'active',
            isApiBot: false,
            isManagerBot: false,
            serviceKey: 'vodafone'
        });

        const response = await request(buildApp())
            .post('/transaction/tx-api-1/assign-executor')
            .set('Accept', 'application/json')
            .set('x-requested-with', 'XMLHttpRequest')
            .send({ executorGroupId: 'human-group-1' });

        expect(addTransferJob).not.toHaveBeenCalled();
        expect(queueService.addJob).not.toHaveBeenCalled();
        expect(eventBus.publish).toHaveBeenCalledWith(
            'executor:task-available',
            expect.objectContaining({ source: 'admin-manual-route' })
        );
        expect(response.status).toBe(200);
        expect(response.body.message).toBe('تم توجيه العملية إلى المنفذ.');
        expect(Transaction.collection.updateOne).toHaveBeenCalledWith(
            { _id: 'tx-api-1', status: 'pending' },
            expect.objectContaining({
                $set: expect.objectContaining({
                    routedByAdminId: 'admin-1',
                    routedByAdminName: 'مدير'
                })
            })
        );
    });

    test('refuses to route when the admin session has no identity', async () => {
        ExecutorGroup.findOne.mockResolvedValue({
            _id: 'human-group-1',
            name: 'منفذ بشري',
            status: 'active',
            isApiBot: false,
            isManagerBot: false,
            serviceKey: 'vodafone'
        });

        const response = await request(buildApp({ isLoggedIn: true, tenantId: 'current-tenant' }))
            .post('/transaction/tx-api-1/assign-executor')
            .set('Accept', 'application/json')
            .set('x-requested-with', 'XMLHttpRequest')
            .send({ executorGroupId: 'human-group-1' });

        expect(response.status).toBe(401);
        expect(response.body.code).toBe('ADMIN_ACTOR_REQUIRED');
        expect(Transaction.collection.updateOne).not.toHaveBeenCalled();
        expect(logAction).not.toHaveBeenCalled();
    });
});

describe('admin assign-executor source contracts', () => {
    const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'adminTransactions.js'), 'utf8');
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

    test('looks up routing executors with adminAccountScope and always dispatches API jobs', () => {
        expect(routeSource).toMatch(/ExecutorGroup\.findOne\(\{ _id: executorGroupId, \.\.\.adminAccountScope\(req\) \}\)/);
        expect(routeSource).toMatch(/ExecutorGroup\.find\(\{ \.\.\.adminAccountScope\(req\), status: 'active', isManagerBot: \{ \$ne: true \} \}\)/);
        expect(routeSource).toMatch(/requireAdminActor\(req\)/);
        expect(routeSource).toMatch(/routingFields\(actor\)/);
        const actorSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'adminActor.js'), 'utf8');
        expect(actorSource).toMatch(/routedByAdminName: actor\.name/);
        const viewSource = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'admin_actor_lines.ejs'), 'utf8');
        expect(viewSource).toContain('وجّهها');
        expect(viewSource).toContain('أودعها');
        expect(viewSource).toContain('خصمها');
        expect(routeSource).toMatch(/enqueueApiExecutorTransfer\(routedTx\._id, executorGroup\._id\)/);
        expect(routeSource).toMatch(/queueService\.addJob\(String\(txId\), String\(apiGroupId\)\)/);
        expect(routeSource).not.toMatch(/executeTransferViaApi\(tx, executorGroup\)/);
        expect(routeSource).toMatch(/applyAdminTxPrivacy\(/);
        expect(routeSource).not.toMatch(/isSubAccountTx: \{ \$ne: true \}/);
    });

    test('starts BullMQ workers after Redis connects', () => {
        expect(appSource).toContain("const { initBullMQ } = require('./services/bullQueueService');");
        expect(appSource).toContain('if (!initBullMQ())');
        expect(appSource.indexOf('initRedis()')).toBeLessThan(
            appSource.indexOf("require('./services/bullQueueService')")
        );
    });
});
