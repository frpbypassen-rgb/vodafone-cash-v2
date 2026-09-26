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

jest.mock('../models/MerchantWebhookDelivery', () => ({
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(async () => ({})),
    find: jest.fn(),
    bulkWrite: jest.fn(),
    createIndexes: jest.fn()
}));

jest.mock('../models/MerchantWebhookEndpoint', () => ({
    findOne: jest.fn(),
    updateOne: jest.fn(async () => ({})),
    find: jest.fn(),
    createIndexes: jest.fn()
}));

jest.mock('../models/User', () => ({
    findOne: jest.fn()
}));

jest.mock('../models/Transaction', () => ({
    find: jest.fn(() => ({ limit: jest.fn(async () => []) })),
    findById: jest.fn()
}));

jest.mock('../models/ExecutorGroup', () => ({
    find: jest.fn(async () => []),
    findById: jest.fn(),
    updateOne: jest.fn(async () => ({}))
}));

jest.mock('../models/Settings', () => ({
    findOne: jest.fn(() => ({ lean: jest.fn(async () => null) }))
}));

jest.mock('../models/Notification', () => ({
    create: jest.fn(async () => ({}))
}));

jest.mock('../models/ApiBalanceAudit', () => ({
    create: jest.fn(),
    createIndexes: jest.fn(),
    findOne: jest.fn()
}));

jest.mock('../models/ApiProviderReturn', () => ({
    createIndexes: jest.fn(),
    updateOne: jest.fn()
}));

jest.mock('../services/walletService', () => ({
    updateBalanceWithLedger: jest.fn()
}));

jest.mock('../services/settlementService', () => ({
    generateDailySettlement: jest.fn(async () => ({})),
    closeEligibleDailySettlement: jest.fn(async () => ({}))
}));

jest.mock('../services/reconciliationService', () => ({
    reconcileDaily: jest.fn(async () => ({}))
}));

jest.mock('../services/queueService', () => ({
    addJob: jest.fn(async () => true),
    processSingleJob: jest.fn(async () => true)
}));

jest.mock('../config/redis', () => ({
    isRedis: jest.fn(() => false),
    getRedisClient: () => null,
    createBullMQConnection: jest.fn(() => null)
}));

jest.mock('bullmq', () => ({
    Queue: jest.fn(() => ({ add: jest.fn(async () => ({ id: 'job' })) })),
    Worker: jest.fn(() => ({ on: jest.fn() }))
}));

const MerchantWebhookDelivery = require('../models/MerchantWebhookDelivery');
const MerchantWebhookEndpoint = require('../models/MerchantWebhookEndpoint');
const Settings = require('../models/Settings');
const queueService = require('../services/queueService');
const settlementService = require('../services/settlementService');
const reconciliationService = require('../services/reconciliationService');
const redis = require('../config/redis');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { encrypt } = require('../utils/encryption');
const { Queue, Worker } = require('bullmq');
const {
    deliverWebhook,
    startMerchantWebhookWorker
} = require('../services/merchantWebhookService');
const {
    executeTransferViaApi,
    getApiProviderBalance,
    getApiProviderTransactions,
    runApiTransferPreflight
} = require('../services/externalApiService');
const zaynpay = require('../services/zaynpayApi');
const {
    initBullMQ,
    addTransferJob,
    addReportJob,
    addReconciliationJob,
    addBackupJob
} = require('../services/bullQueueService');
const { startApiCompletionMonitor, scheduleApiCompletion } = require('../services/apiExecutionLifecycleService');
const { startApiProviderReturnMonitor } = require('../services/apiProviderReconciliationService');
const {
    restorePendingRateActivation,
    startRateChangeActivationMonitor
} = require('../services/rateChangeService');
const { assertStagingStartupSafe } = require('../utils/stagingStartupGuard');
const {
    disabledSubsystemFlags,
    isExplicitlyEnabled,
    resolveProviderBaseUrl
} = require('../utils/runtimeControls');

const FLAG_KEYS = [
    'MERCHANT_WEBHOOK_WORKER_ENABLED',
    'EXTERNAL_API_ENABLED',
    'BULLMQ_WORKERS_ENABLED',
    'FINANCIAL_SCHEDULERS_ENABLED',
    'APP_ENV',
    'ENVIRONMENT',
    'ZAYN_AGGREGATOR_URL',
    'ZAYNPAY_URL',
    'ZAYN_EXECUTOR_API_URL',
    'ZAYN_USERNAME',
    'ZAYN_PASSWORD',
    'STAGING_SANDBOX_HOST_ALLOWLIST',
    'PORT',
    'SMTP_HOST',
    'MONGO_URI',
    'PM2_NAME',
    'PM2_APP_NAME',
    'name'
];

const savedEnv = {};

const fakeDb = (collections = {}) => ({
    listCollections: () => ({
        toArray: async () => Object.keys(collections).map((name) => ({ name }))
    }),
    collection: (name) => ({
        find: () => ({
            toArray: async () => collections[name] || []
        })
    })
});

const safeStagingEnv = {
    NODE_ENV: 'staging',
    APP_ENV: 'staging',
    PORT: '3200',
    SMTP_HOST: '127.0.0.1',
    MONGO_URI: 'mongodb://127.0.0.1:27018/ahram_pay_sandbox?replicaSet=rs0',
    name: 'Ahram_QA_Staging'
};

describe('runtime isolation kill switches', () => {
    let httpRequest;
    let httpsRequest;

    beforeEach(() => {
        jest.clearAllMocks();
        FLAG_KEYS.forEach((key) => {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        });
        if (process.env.NODE_ENV === 'staging') process.env.NODE_ENV = 'test';
        httpRequest = jest.spyOn(http, 'request').mockImplementation(() => {
            throw new Error('unexpected http.request');
        });
        httpsRequest = jest.spyOn(https, 'request').mockImplementation(() => {
            throw new Error('unexpected https.request');
        });
        global.fetch = jest.fn(() => {
            throw new Error('unexpected fetch');
        });
        axios.post.mockReset();
        axios.get.mockReset();
    });

    afterEach(() => {
        httpRequest.mockRestore();
        httpsRequest.mockRestore();
        FLAG_KEYS.forEach((key) => {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        });
        jest.useRealTimers();
    });

    test('truthy parsing matches the password-reset flag and defaults off', () => {
        expect(isExplicitlyEnabled(undefined)).toBe(false);
        expect(isExplicitlyEnabled('')).toBe(false);
        expect(isExplicitlyEnabled('false')).toBe(false);
        expect(isExplicitlyEnabled('0')).toBe(false);
        ['1', 'true', 'yes', 'on', ' TRUE '].forEach((value) => {
            expect(isExplicitlyEnabled(value)).toBe(true);
        });
        expect(disabledSubsystemFlags({})).toEqual([
            'MERCHANT_WEBHOOK_WORKER_ENABLED',
            'EXTERNAL_API_ENABLED',
            'BULLMQ_WORKERS_ENABLED',
            'FINANCIAL_SCHEDULERS_ENABLED'
        ]);
    });

    test('merchant webhook worker and delivery make no HTTP when the flag is off', async () => {
        const timerSpy = jest.spyOn(global, 'setInterval');
        expect(startMerchantWebhookWorker()).toBeNull();
        await expect(deliverWebhook('delivery-1')).resolves.toEqual({
            skipped: true,
            reason: 'MERCHANT_WEBHOOK_DISABLED'
        });
        expect(timerSpy).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
        expect(axios.get).not.toHaveBeenCalled();
        expect(MerchantWebhookDelivery.findOneAndUpdate).not.toHaveBeenCalled();
        expect(httpRequest).not.toHaveBeenCalled();
        expect(httpsRequest).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        timerSpy.mockRestore();
    });

    test('merchant webhook delivery calls axios when the flag is on', async () => {
        process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = 'true';
        MerchantWebhookDelivery.findOneAndUpdate.mockResolvedValue({
            _id: 'delivery-1',
            endpointId: 'endpoint-1',
            payload: { id: 'evt-1' },
            eventType: 'transfer.created',
            attemptCount: 1
        });
        MerchantWebhookEndpoint.findOne.mockReturnValue({
            select: () => Promise.resolve({
                _id: 'endpoint-1',
                url: 'https://hooks.example.test/pay',
                secretEncrypted: encrypt('webhook-secret'),
                enabled: true
            })
        });
        axios.post.mockResolvedValue({ status: 204, data: '' });
        const timer = startMerchantWebhookWorker();
        expect(timer).toBeTruthy();
        clearInterval(timer);
        const result = await deliverWebhook('delivery-1');
        expect(result).toEqual({ delivered: true });
        expect(axios.post).toHaveBeenCalledWith(
            'https://hooks.example.test/pay',
            expect.any(String),
            expect.objectContaining({ timeout: 10000 })
        );
    });

    test('external provider calls do not use HTTP when EXTERNAL_API_ENABLED is off', async () => {
        const bot = {
            apiUrl: 'https://zayn.example',
            apiUsername: 'api-user',
            apiPassword: 'api-pass'
        };
        const transfer = await executeTransferViaApi(
            { vodafoneNumber: '01271870153', amount: 5 },
            bot
        );
        const preflight = await runApiTransferPreflight(bot, { phone: '01271870153', amount: 5 });
        const balance = await getApiProviderBalance(bot);
        const review = await getApiProviderTransactions(bot, ['9001']);
        expect(transfer).toMatchObject({ success: false, code: 'EXTERNAL_API_DISABLED' });
        expect(preflight.code).toBe('EXTERNAL_API_DISABLED');
        expect(balance.code).toBe('EXTERNAL_API_DISABLED');
        expect(review).toMatchObject({ success: false, code: 'EXTERNAL_API_DISABLED', operations: [] });
        await expect(zaynpay.inquiry('01271870153', 5)).rejects.toThrow('EXTERNAL_API_DISABLED');
        const payment = await zaynpay.pay('bill', '01271870153', 5);
        expect(payment.success).toBe(false);
        expect(payment.error).toContain('EXTERNAL_API_DISABLED');
        expect(axios.post).not.toHaveBeenCalled();
        expect(httpRequest).not.toHaveBeenCalled();
        expect(httpsRequest).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('external provider calls proceed when EXTERNAL_API_ENABLED is on', async () => {
        process.env.EXTERNAL_API_ENABLED = 'true';
        axios.post
            .mockResolvedValueOnce({ data: { Code: 200, Data: { Access_Token: 'token-1' } } })
            .mockResolvedValueOnce({ data: { Code: 200, Data: { PaymentBillInfo: 'bill-1' } } })
            .mockResolvedValueOnce({
                data: {
                    Code: 200,
                    Data: {
                        TransactionNumber: '5001',
                        RefTransactionNumber: '2805',
                        Amount: 5,
                        Status: 'عمليه ناجحه'
                    }
                }
            });
        const result = await executeTransferViaApi(
            { vodafoneNumber: '01271870153', amount: 5, customId: 'ATT-1' },
            { apiUrl: 'https://zayn.example', apiUsername: 'api-user', apiPassword: 'api-pass' }
        );
        expect(result.success).toBe(true);
        expect(axios.post).toHaveBeenCalled();
        expect(String(axios.post.mock.calls[0][0])).toBe('https://zayn.example/api/Account/GetToken');
    });

    test('production still falls back to https://zaynpay.com and staging refuses it', async () => {
        process.env.EXTERNAL_API_ENABLED = 'true';
        process.env.NODE_ENV = 'test';
        expect(resolveProviderBaseUrl({
            explicitUrl: '',
            presetUrl: 'https://zaynpay.com',
            env: { NODE_ENV: 'production' }
        })).toMatchObject({ baseUrl: 'https://zaynpay.com', refused: false });

        axios.post.mockResolvedValue({ data: { Code: 401, Message: 'no' } });
        process.env.ZAYN_USERNAME = 'user';
        process.env.ZAYN_PASSWORD = 'pass';
        await zaynpay.login().catch(() => {});
        expect(axios.post).toHaveBeenCalledWith(
            'https://zaynpay.com/api/Account/GetToken',
            expect.any(Object),
            expect.any(Object)
        );

        axios.post.mockClear();
        process.env.NODE_ENV = 'staging';
        delete process.env.ZAYN_AGGREGATOR_URL;
        delete process.env.ZAYNPAY_URL;
        const unset = await executeTransferViaApi(
            { vodafoneNumber: '01271870153', amount: 5 },
            { apiUsername: 'api-user', apiPassword: 'api-pass' }
        );
        expect(unset).toMatchObject({ success: false, code: 'PROVIDER_URL_REFUSED' });
        const realHost = await executeTransferViaApi(
            { vodafoneNumber: '01271870153', amount: 5 },
            { apiUrl: 'https://zaynpay.com', apiUsername: 'api-user', apiPassword: 'api-pass' }
        );
        expect(realHost.code).toBe('PROVIDER_URL_REFUSED');
        await expect(zaynpay.inquiry('01271870153', 5)).rejects.toThrow('PROVIDER_URL_REFUSED');
        expect(axios.post).not.toHaveBeenCalled();

        axios.post.mockResolvedValueOnce({ data: { Code: 200, Data: { Access_Token: 'local-token' } } });
        const local = await getApiProviderBalance({
            apiUrl: 'http://127.0.0.1:4010',
            apiUsername: 'api-user',
            apiPassword: 'api-pass'
        });
        expect(axios.post).toHaveBeenCalledWith(
            'http://127.0.0.1:4010/api/Account/GetToken',
            expect.any(Object),
            expect.any(Object)
        );
        expect(local.success).toBe(false);
    });

    test('BullMQ workers and in-process processors do not start when the flag is off', async () => {
        redis.isRedis.mockReturnValue(true);
        redis.createBullMQConnection.mockReturnValue({ ok: true });
        expect(initBullMQ()).toBe(false);
        await addTransferJob('tx-1', 'group-1');
        await addReportJob('daily_settlement', new Date());
        await addReconciliationJob(new Date());
        await addBackupJob();
        expect(Worker).not.toHaveBeenCalled();
        expect(Queue).not.toHaveBeenCalled();
        expect(queueService.addJob).not.toHaveBeenCalled();
        expect(settlementService.generateDailySettlement).not.toHaveBeenCalled();
        expect(reconciliationService.reconcileDaily).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('BullMQ init still creates workers when the flag is on', () => {
        process.env.BULLMQ_WORKERS_ENABLED = 'true';
        redis.isRedis.mockReturnValue(true);
        redis.createBullMQConnection.mockReturnValue({ ok: true });
        expect(initBullMQ()).toBe(true);
        expect(Worker).toHaveBeenCalled();
        expect(Queue).toHaveBeenCalled();
    });

    test('financial schedulers do not start when the flag is off and do start when it is on', () => {
        jest.useFakeTimers();
        expect(startApiCompletionMonitor()).toBeNull();
        expect(startApiProviderReturnMonitor()).toBeNull();
        expect(startRateChangeActivationMonitor({ app: {} })).toBeNull();
        expect(scheduleApiCompletion({ txId: 'tx', executorGroupId: 'group' })).toBeNull();
        expect(jest.getTimerCount()).toBe(0);
        expect(Settings.findOne).not.toHaveBeenCalled();

        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
        const completion = startApiCompletionMonitor();
        const returns = startApiProviderReturnMonitor();
        const rates = startRateChangeActivationMonitor({ app: {} });
        const delayed = scheduleApiCompletion({ txId: 'tx', executorGroupId: 'group', delayMs: 1000 });
        expect(completion).toBeTruthy();
        expect(returns).toBeTruthy();
        expect(rates).toBeTruthy();
        expect(delayed).toBeTruthy();
        jest.clearAllTimers();
    });

    test('restorePendingRateActivation does not read settings when schedulers are off', async () => {
        await expect(restorePendingRateActivation({ app: {} })).resolves.toBeNull();
        expect(Settings.findOne).not.toHaveBeenCalled();
        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
        await expect(restorePendingRateActivation({ app: {} })).resolves.toBeNull();
        expect(Settings.findOne).toHaveBeenCalled();
    });
});

describe('staging startup guard', () => {
    const saved = {};

    beforeEach(() => {
        ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'PORT', 'SMTP_HOST', 'MONGO_URI', 'ZAYN_AGGREGATOR_URL', 'name', 'PM2_NAME']
            .forEach((key) => {
                saved[key] = process.env[key];
            });
    });

    afterEach(() => {
        Object.keys(saved).forEach((key) => {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        });
    });

    const apply = (env) => {
        Object.keys(env).forEach((key) => {
            process.env[key] = env[key];
        });
    };

    test('accepts localhost Mailpit, a non-production port, and no providers', async () => {
        apply(safeStagingEnv);
        const result = await assertStagingStartupSafe({
            env: process.env,
            db: fakeDb(),
            processTitle: 'node'
        });
        expect(result.ok).toBe(true);
    });

    test('does not apply the guard outside staging', async () => {
        apply({
            ...safeStagingEnv,
            NODE_ENV: 'production',
            APP_ENV: 'production',
            ENVIRONMENT: 'production',
            PORT: '3000',
            SMTP_HOST: 'smtp.gmail.com',
            ZAYN_AGGREGATOR_URL: 'https://zaynpay.com',
            MONGO_URI: 'mongodb://127.0.0.1:27017/vodafone_cash_system'
        });
        const result = await assertStagingStartupSafe({
            env: process.env,
            db: fakeDb({
                merchantwebhookendpoints: [{ url: 'https://hooks.merchant.example/pay' }]
            }),
            processTitle: 'Ahram_Core_API'
        });
        expect(result.ok).toBe(true);
    });

    test.each([
        ['external SMTP', { SMTP_HOST: 'smtp.gmail.com' }, 'SMTP_RELAY_EXTERNAL'],
        ['external provider URL', { ZAYN_AGGREGATOR_URL: 'https://zaynpay.com' }, 'PROVIDER_URL_EXTERNAL'],
        ['port 3000', { PORT: '3000' }, 'PORT_PRODUCTION'],
        ['unset port', { PORT: '' }, 'PORT_PRODUCTION'],
        ['production PM2 name', { name: 'Ahram_Core_API' }, 'PM2_PRODUCTION_NAME'],
        ['production database', { MONGO_URI: 'mongodb://127.0.0.1:27017/vodafone_cash_system' }, 'DATABASE_PRODUCTION'],
        ['legacy production database', { MONGO_URI: 'mongodb://127.0.0.1:27017/vodafone_cash' }, 'DATABASE_PRODUCTION']
    ])('rejects %s', async (_label, override, code) => {
        apply({ ...safeStagingEnv, ...override });
        if (Object.prototype.hasOwnProperty.call(override, 'PORT') && override.PORT === '') {
            delete process.env.PORT;
        }
        await expect(assertStagingStartupSafe({
            env: process.env,
            db: fakeDb(),
            processTitle: 'node'
        })).rejects.toMatchObject({ code: 'STAGING_STARTUP_REFUSED' });
        try {
            await assertStagingStartupSafe({
                env: process.env,
                db: fakeDb(),
                processTitle: 'node'
            });
        } catch (error) {
            expect(error.violations.map((item) => item.code)).toContain(code);
        }
    });

    test('rejects an external webhook URL stored in the database and a production process title', async () => {
        apply(safeStagingEnv);
        await expect(assertStagingStartupSafe({
            env: process.env,
            db: fakeDb({
                merchantwebhookendpoints: [{ url: 'https://hooks.merchant.example/pay' }],
                executorgroups: [{ apiUrl: '' }]
            }),
            processTitle: 'node'
        })).rejects.toThrow(/WEBHOOK_URL_EXTERNAL/);

        await expect(assertStagingStartupSafe({
            env: process.env,
            db: fakeDb(),
            processTitle: 'Ahram_Core_API'
        })).rejects.toThrow(/PM2_PRODUCTION_NAME/);
    });
});
