'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Transaction = require('../models/Transaction');
const { claimProviderDispatch } = require('../services/providerDispatchClaimService');
const { buildRecoveryFence, pristine, summarize } = require('../services/apiRuntimeRecoveryPolicy');
let replica, tx;
jest.setTimeout(120000);
beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replica.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    if (replica) await replica.stop();
});
beforeEach(async () => {
    await Transaction.collection.deleteMany({});
    tx = {
        _id: new mongoose.Types.ObjectId(),
        customId: 'ATT-TEST-RECOVERY',
        status: 'processing',
        executorGroupId: new mongoose.Types.ObjectId(),
        updatedAt: new Date(),
        apiResultData: { existingPreference: 'keep' },
    };
    await Transaction.collection.insertOne(tx);
});

test('a recovery fence blocks a Payment claim even from an already loaded worker document', async () => {
    const fence = buildRecoveryFence(tx, 'recovery-test');
    expect((await Transaction.collection.updateOne(fence.filter, fence.update)).modifiedCount).toBe(1);
    expect((await claimProviderDispatch(tx)).claimed).toBe(false);
    expect((await Transaction.collection.findOne({ _id: tx._id })).apiResultData.runtimeRecoveryFence).toBe(
        'recovery-test'
    );
    expect(
        (await Transaction.collection.updateOne(fence.releaseFilter, fence.releaseUpdate)).modifiedCount
    ).toBe(1);
    expect((await claimProviderDispatch(tx)).claimed).toBe(true);
    expect((await claimProviderDispatch(tx)).claimed).toBe(false);
});

test('if Payment claims first, recovery cannot replace its dispatch evidence', async () => {
    const fence = buildRecoveryFence(tx, 'recovery-test');
    const claim = await claimProviderDispatch({ ...tx });
    expect(claim.claimed).toBe(true);
    expect((await Transaction.collection.updateOne(fence.filter, fence.update)).modifiedCount).toBe(0);
    expect(
        (await Transaction.collection.findOne({ _id: tx._id })).apiResultData.providerDispatchAttemptId
    ).toBe(claim.attemptId);
});

test('concurrent changes prevent fence release instead of being overwritten', async () => {
    const fence = buildRecoveryFence(tx, 'recovery-test');
    await Transaction.collection.updateOne(fence.filter, fence.update);
    await Transaction.collection.updateOne(
        { _id: tx._id },
        { $set: { 'apiResultData.operatorNote': 'new evidence' } }
    );
    expect(
        (await Transaction.collection.updateOne(fence.releaseFilter, fence.releaseUpdate)).modifiedCount
    ).toBe(0);
    const stored = await Transaction.collection.findOne({ _id: tx._id });
    expect(stored.apiResultData.operatorNote).toBe('new evidence');
    expect(stored.apiResultData.runtimeRecoveryFence).toBe('recovery-test');
});

test('a paid completed transaction is never classified as safe to resend or fence', () => {
    const paid = {
        ...tx,
        status: 'completed',
        apiResultData: {
            providerDispatchResult: 'accepted',
            referenceNumber: 'reference',
            ledgerPosted: false,
        },
    };
    expect(pristine(paid)).toBe(false);
    expect(summarize(paid)).toMatchObject({ terminal: true, result: 'accepted', ledgerPosted: false });
    expect(() => buildRecoveryFence(paid, 'recovery-test')).toThrow('TARGET_NOT_PRISTINE');
});

test.each(['absent', 'null'])('fencing restores an originally %s API data field exactly', async (kind) => {
    if (kind === 'absent')
        await Transaction.collection.updateOne({ _id: tx._id }, { $unset: { apiResultData: '' } });
    else await Transaction.collection.updateOne({ _id: tx._id }, { $set: { apiResultData: null } });
    const original = await Transaction.collection.findOne({ _id: tx._id });
    const fence = buildRecoveryFence(original, 'restore-test');
    expect((await Transaction.collection.updateOne(fence.filter, fence.update)).modifiedCount).toBe(1);
    expect((await claimProviderDispatch(original)).claimed).toBe(false);
    expect(
        (await Transaction.collection.updateOne(fence.releaseFilter, fence.releaseUpdate)).modifiedCount
    ).toBe(1);
    const restored = await Transaction.collection.findOne({ _id: tx._id });
    expect(Object.prototype.hasOwnProperty.call(restored, 'apiResultData')).toBe(kind === 'null');
    if (kind === 'null') expect(restored.apiResultData).toBeNull();
});

test.each([
    { providerReportedReference: 'evidence' },
    { waitingApiAutoCompletion: true },
    { providerResolutionOutcome: 'provider_paid' },
])('prior provider evidence prevents an automatic recovery fence', (apiResultData) => {
    expect(pristine({ ...tx, apiResultData })).toBe(false);
});
