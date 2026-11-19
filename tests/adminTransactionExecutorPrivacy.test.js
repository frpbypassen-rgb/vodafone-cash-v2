'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');


jest.mock('../models/Transaction', () => ({ countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ find: jest.fn() }));
jest.mock('../models/Ledger', () => ({}));
jest.mock('../models/ClientCompany', () => ({}));
jest.mock('../models/Employee', () => ({}));
jest.mock('../models/ClientEmployee', () => ({}));
jest.mock('../models/Admin', () => ({}));
jest.mock('../models/Notification', () => ({}));
jest.mock('../models/SupportTicket', () => ({}));
jest.mock('../services/bullQueueService', () => ({ addTransferJob: jest.fn(), initBullMQ: jest.fn() }));
jest.mock('../services/queueService', () => ({ addJob: jest.fn(), processSingleJob: jest.fn() }));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));
jest.mock('../services/externalApiService', () => ({ getApiProviderBalance: jest.fn(), executeTransferViaApi: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../services/operationsWorkspaceSummaryService', () => ({ loadOperationsSummaryStrip: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/centralLedgerOverviewService', () => ({
    emptyPeriodStats: () => ({ today: {}, week: {}, month: {} }),
    loadCentralLedgerOverview: jest.fn().mockResolvedValue({
        periodStats: { today: {}, week: {}, month: {} }, activeClientCompanies: [], fundedExecutorCompanies: []
    })
}));

const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const adminTransactions = require('../routes/adminTransactions');

const credentials = {
    apiPassword: 'private-provider-password-never-render',
    apiToken: 'private-provider-token-never-render',
    kenanWebhookSecret: 'private-webhook-secret-never-render',
    futureCredential: { token: 'new-secret-field-never-render' }
};
const groupData = {
    _id: '507f1f77bcf86cd799439011', name: 'منفذ الاختبار', serviceKey: 'postal',
    serviceKeys: ['postal', 'vodafone'], isApiBot: true, balance: 900,
    apiUsername: 'private-provider-username', ...credentials
};

const makeApp = () => {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '../views'));
    app.enable('view cache');
    app.use((req, res, next) => {
        req.session = { isLoggedIn: true, adminRole: 'master', adminName: 'Test admin' };
        res.locals.adminName = 'Test admin';
        res.locals.role = 'master';
        res.locals.csrfToken = 'test-csrf';
        next();
    });
    app.use(adminTransactions);
    return app;
};

let app, server;

async function readOperationsPage() {
    const url = new URL('/transactions/operations', 'http://127.0.0.1');
    url.port = String(server.address().port);
    const response = await fetch(url);
    return { status: response.status, text: await response.text() };
}
beforeAll(async () => {
    // Compile the real page/includes once outside individual request timings.
    // Cold EJS startup shares CPU with the full suite's recycled Jest workers.
    Transaction.countDocuments.mockResolvedValue(0);
    Transaction.aggregate.mockResolvedValue([]);
    ExecutorGroup.find.mockImplementation(() => Object.assign(Promise.resolve([]), {
        lean: jest.fn().mockResolvedValue([])
    }));
    app = makeApp();
    // Own one explicitly loopback-bound server for the suite. Do not create and
    // close a different dual-stack listener for each Supertest request.
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    expect((await readOperationsPage()).status).toBe(200);
}, 30000);

afterAll(async () => {
    if (server?.listening) await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
});

beforeEach(() => {
    jest.clearAllMocks();
    Transaction.countDocuments.mockResolvedValue(0);
    Transaction.aggregate.mockResolvedValue([]);
});

test.each([false, true])('real operations HTML exposes only executor selection fields (document=%s)', async (document) => {
    const group = document ? { ...groupData, toObject: () => ({ ...groupData }) } : { ...groupData };
    ExecutorGroup.find.mockImplementation(() => Object.assign(Promise.resolve([group]), {
        lean: jest.fn().mockResolvedValue([{ ...groupData }])
    }));
    const response = await readOperationsPage();
    expect(response.status).toBe(200);
    const serialized = response.text.match(/<script id="executorBotsData"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    expect(serialized).toBeDefined();
    const bots = JSON.parse(serialized);
    expect(bots).toEqual([{
        _id: groupData._id, name: groupData.name, serviceKey: 'postal',
        serviceLabel: 'خدمات البريد', supportedTransferTypes: ['post_account', 'post_card', 'vodafone']
    }]);
    for (const secret of [credentials.apiPassword, credentials.apiToken, credentials.kenanWebhookSecret,
        credentials.futureCredential.token, groupData.apiUsername]) expect(response.text).not.toContain(secret);
});
