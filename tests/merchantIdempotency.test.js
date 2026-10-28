'use strict';
jest.mock('../services/autoRouteService', () => ({
    resolveAutoRouteExecutor: jest.fn(async () => null),
    applyAutoRouteFields: jest.fn(),
    enqueueAutoRouteIfNeeded: jest.fn(async () => {}),
}));
jest.mock('../services/transferCooldownService', () => ({
    acquireTransferCooldown: jest.fn(async () => ({
        lock: {},
        guardFields: {},
    })),
    releaseTransferCooldown: jest.fn(async () => {}),
}));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));
const mongoose = require('mongoose'),
    express = require('express'),
    request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Company = require('../models/ClientCompany'),
    User = require('../models/User'),
    Transaction = require('../models/Transaction'),
    Ledger = require('../models/Ledger'),
    Counter = require('../models/Counter'),
    Settings = require('../models/Settings');
const events = require('../services/eventBus');
let repl, app;
jest.setTimeout(120000);
beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await mongoose.connect(repl.getUri());
    await Promise.all([
        Transaction.init(),
        Counter.init(),
        Company.init(),
        User.init(),
        Ledger.init(),
        Settings.init(),
    ]);
    app = express();
    app.use(express.json());
    app.use('/api/v1/merchant', require('../routes/merchantApi'));
});
afterAll(async () => {
    await mongoose.disconnect();
    await repl.stop();
});
beforeEach(async () => {
    await Promise.all([
        Transaction.deleteMany({}),
        Ledger.deleteMany({}),
        Company.deleteMany({}),
        User.deleteMany({}),
        Counter.deleteMany({}),
        Settings.deleteMany({}),
    ]);
    await Settings.create({ rateLevel3: 5, cashRateLevel3: 5 });
    jest.clearAllMocks();
});
const body = {
    target_number: '01012345678',
    amount: 1000,
    transfer_type: 'vodafone',
};
const send = (token, key, data = body) => {
    const r = request(app)
        .post('/api/v1/merchant/transfer')
        .set('x-api-key', token);
    if (key !== undefined) r.set('Idempotency-Key', key);
    return r.send(data);
};
for (const kind of ['company', 'agent'])
    test(`${kind}: replays the same committed response without a second debit, ledger or event and rejects payload reuse`, async () => {
        const token = 'test-key-' + kind,
            Model = kind === 'company' ? Company : User;
        const entity = await Model.create({
            name: 'Isolated merchant',
            tier: 3,
            balance: 1000,
            status: 'active',
            ...(kind === 'company'
                ? { token }
                : {
                      role: 'agent',
                      webUsername: 'isolated-agent',
                      webPassword: 'test-password-123',
                      apiToken: token,
                  }),
            integrationAccess: { apiEnabled: true },
        });
        const first = await send(token, 'order-123');
        expect(first.status).toBe(200);
        const replay = await send(token, 'order-123');
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual(first.body);
        expect(replay.headers['idempotency-replayed']).toBe('true');
        expect(
            (await send(token, 'order-123', { ...body, amount: 1001 })).status,
        ).toBe(409);
        expect(await Transaction.countDocuments({})).toBe(1);
        expect(await Ledger.countDocuments({})).toBe(1);
        expect(events.publish).toHaveBeenCalledTimes(1);
        expect((await Model.findById(entity._id)).balance).toBe(800);
        expect(JSON.stringify(await Transaction.find().lean())).not.toContain(
            'order-123',
        );
    });
test('concurrent identical keys create one financial result; retry after conflict replays it', async () => {
    const merchant = await Company.create({
        name: 'Concurrent',
        tier: 3,
        balance: 1000,
        token: 'concurrent-token',
        integrationAccess: { apiEnabled: true },
    });
    const pair = await Promise.all([
        send('concurrent-token', 'concurrent-key'),
        send('concurrent-token', 'concurrent-key'),
    ]);
    expect(pair.some((r) => r.status === 200)).toBe(true);
    expect(pair.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect((await send('concurrent-token', 'concurrent-key')).body).toEqual(
        pair.find((r) => r.status === 200).body,
    );
    expect(await Transaction.countDocuments({})).toBe(1);
    expect(await Ledger.countDocuments({})).toBe(1);
    expect((await Company.findById(merchant._id)).balance).toBe(800);
});
test('a failed financial transaction does not consume the key or debit; another account may use the same raw key', async () => {
    const a = await Company.create({
        name: 'A',
        tier: 3,
        balance: 0,
        token: 'token-a',
        integrationAccess: { apiEnabled: true },
    });
    await Company.create({
        name: 'B',
        tier: 3,
        balance: 1000,
        token: 'token-b',
        integrationAccess: { apiEnabled: true },
    });
    expect((await send('token-a', 'shared-key')).status).toBe(400);
    expect(await Transaction.countDocuments({})).toBe(0);
    await Company.updateOne({ _id: a._id }, { $set: { balance: 1000 } });
    expect((await send('token-a', 'shared-key')).status).toBe(200);
    expect((await send('token-b', 'shared-key')).status).toBe(200);
    expect(await Transaction.countDocuments({})).toBe(2);
    expect(await Ledger.countDocuments({})).toBe(2);
});
test('a post-commit response failure can be recovered by replay without another financial write', async () => {
    const merchant = await Company.create({
        name: 'Lost response',
        tier: 3,
        balance: 1000,
        token: 'lost-response-token',
        integrationAccess: { apiEnabled: true },
    });
    events.publish.mockImplementationOnce(() => {
        throw new Error('SIMULATED_POST_COMMIT_FAILURE');
    });
    expect(
        (await send('lost-response-token', 'lost-response-key')).status,
    ).toBe(500);
    const retried = await send('lost-response-token', 'lost-response-key');
    expect(retried.status).toBe(200);
    expect(retried.headers['idempotency-replayed']).toBe('true');
    expect(await Transaction.countDocuments({})).toBe(1);
    expect(await Ledger.countDocuments({})).toBe(1);
    expect((await Company.findById(merchant._id)).balance).toBe(800);
});
test('keyed requests fail closed when no transaction session is available, and malformed keys cannot create transfers', async () => {
    const merchant = await Company.create({
        name: 'Fail closed',
        tier: 3,
        balance: 1000,
        token: 'fail-closed-token',
        integrationAccess: { apiEnabled: true },
    });
    expect((await send('fail-closed-token', 'bad key')).status).toBe(400);
    const sessionSpy = jest
        .spyOn(mongoose, 'startSession')
        .mockRejectedValueOnce(new Error('Session unavailable'));
    try {
        expect((await send('fail-closed-token', 'safe-key')).status).toBe(503);
    } finally {
        sessionSpy.mockRestore();
    }
    expect(await Transaction.countDocuments({})).toBe(0);
    expect(await Ledger.countDocuments({})).toBe(0);
    expect((await Company.findById(merchant._id)).balance).toBe(1000);
});
test('replay still requires current token and IP permission; token rotation preserves owner-scoped replay', async () => {
    const merchant = await Company.create({
        name: 'Auth-bound replay',
        tier: 3,
        balance: 1000,
        token: 'old-auth-token',
        integrationAccess: { apiEnabled: true },
    });
    const first = await send('old-auth-token', 'auth-bound-key');
    expect(first.status).toBe(200);
    await Company.updateOne(
        { _id: merchant._id },
        {
            $set: {
                'integrationAccess.ipAllowlistEnabled': true,
                'integrationAccess.allowedIps': ['192.0.2.1'],
            },
        },
    );
    expect((await send('old-auth-token', 'auth-bound-key')).status).toBe(403);
    await Company.updateOne(
        { _id: merchant._id },
        { $set: { 'integrationAccess.ipAllowlistEnabled': false } },
    );
    const rotated =
        await require('../services/merchantIntegrationService').rotateKey({
            isCompany: true,
            entity: merchant,
            permissions: { owner: true },
        });
    expect((await send('old-auth-token', 'auth-bound-key')).status).toBe(401);
    expect((await send(rotated.token, 'auth-bound-key')).body).toEqual(
        first.body,
    );
    expect(await Transaction.countDocuments({})).toBe(1);
    expect(await Ledger.countDocuments({})).toBe(1);
});
test('response persistence failure rolls back the transfer, ledger and debit before the same key is retried', async () => {
    const merchant = await Company.create({
        name: 'Atomic response',
        tier: 3,
        balance: 1000,
        token: 'atomic-response-token',
        integrationAccess: { apiEnabled: true },
    });
    const storeSpy = jest
        .spyOn(Transaction, 'updateOne')
        .mockRejectedValueOnce(new Error('SIMULATED_RESPONSE_STORE_FAILURE'));
    try {
        expect((await send('atomic-response-token', 'atomic-key')).status).toBe(
            500,
        );
    } finally {
        storeSpy.mockRestore();
    }
    expect(await Transaction.countDocuments({})).toBe(0);
    expect(await Ledger.countDocuments({})).toBe(0);
    expect((await Company.findById(merchant._id)).balance).toBe(1000);
    expect((await send('atomic-response-token', 'atomic-key')).status).toBe(
        200,
    );
    expect(await Transaction.countDocuments({})).toBe(1);
    expect(await Ledger.countDocuments({})).toBe(1);
});

test('a missing unique idempotency index rejects a new keyed transfer before any financial write', async () => {
    const merchant = await Company.create({ name: 'Index guard', tier: 3, balance: 1000,
        token: 'index-guard-token', integrationAccess: { apiEnabled: true } });
    const spy = jest.spyOn(Transaction.collection, 'listIndexes').mockReturnValue({
        toArray: async () => [{ key: { idempotencyKey: 1 }, unique: false }],
    });
    try {
        const result = await send('index-guard-token', 'index-key');
        expect(result.status).toBe(503);
        expect(result.body.code).toBe('IDEMPOTENCY_INDEX_UNAVAILABLE');
        expect(await Transaction.countDocuments({})).toBe(0);
        expect(await Ledger.countDocuments({})).toBe(0);
        expect((await Company.findById(merchant._id)).balance).toBe(1000);
    } finally { spy.mockRestore(); }
    expect((await send('index-guard-token', 'index-key')).status).toBe(200);
});

test('transient write conflicts are retried inside the transaction without a client conflict or repeated financial effects', async () => {
    const merchant=await Company.create({name:'Transient retry',tier:3,balance:1000,token:'transient-token',integrationAccess:{apiEnabled:true}});
    const error=new mongoose.mongo.MongoServerError({message:'Injected write conflict',code:112,errorLabels:['TransientTransactionError']});
    const spy=jest.spyOn(Transaction,'updateOne').mockRejectedValueOnce(error);
    try {expect((await send('transient-token','transient-retry')).status).toBe(200);} finally {spy.mockRestore();}
    expect(await Transaction.countDocuments({})).toBe(1);expect(await Ledger.countDocuments({})).toBe(1);
    expect((await Company.findById(merchant._id)).balance).toBe(800);expect(events.publish).toHaveBeenCalledTimes(1);
});

test('an uncertain commit acknowledgement retries only commit and never reexecutes the debit body',async()=>{
    const merchant=await Company.create({name:'Commit retry',tier:3,balance:1000,token:'commit-token',integrationAccess:{apiEnabled:true}});
    const session=await mongoose.startSession(),commit=session.commitTransaction.bind(session);
    const commitSpy=jest.spyOn(session,'commitTransaction').mockImplementationOnce(async()=>{
        await commit();throw new mongoose.mongo.MongoServerError({message:'Lost commit acknowledgement',code:91,errorLabels:['UnknownTransactionCommitResult']});
    });
    const startSpy=jest.spyOn(mongoose,'startSession').mockResolvedValueOnce(session);
    const saveSpy=jest.spyOn(Ledger.prototype,'save');
    try {
        expect((await send('commit-token','commit-retry')).status).toBe(200);
        expect(commitSpy).toHaveBeenCalledTimes(2);expect(saveSpy).toHaveBeenCalledTimes(1);
    } finally {startSpy.mockRestore();saveSpy.mockRestore();commitSpy.mockRestore();}
    expect(await Transaction.countDocuments({})).toBe(1);expect(await Ledger.countDocuments({})).toBe(1);
    expect((await Company.findById(merchant._id)).balance).toBe(800);expect(events.publish).toHaveBeenCalledTimes(1);
});
