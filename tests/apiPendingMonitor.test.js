'use strict';

jest.mock('../services/externalApiService', () => ({
    getApiProviderTransaction: jest.fn(),
    isMaskedProviderReference: (value) => /[*＊×•·]/u.test(String(value || ''))
}));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Notification = require('../models/Notification');
const { getApiProviderTransaction } = require('../services/externalApiService');
const monitor = require('../services/apiPendingMonitorService');
const { pendingProviderQuery } = require('../utils/providerPendingOperation');

jest.setTimeout(120000);
let database;
let serial = 0;
const envKeys = ['FINANCIAL_SCHEDULERS_ENABLED', 'EXTERNAL_API_ENABLED', 'API_PENDING_MONITOR_ENABLED'];
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const receipt = () => ({ success: true, providerTransactionId: '6103691', referenceNumber: '0121****429',
    phone: '01099887766', amount: 100, providerStatus: 'عمليه ناجحه', isReturned: false });
const createPending = async (data = {}) => {
    const tenantId = new mongoose.Types.ObjectId();
    const group = await ExecutorGroup.create({ name: 'Mock API only', isApiBot: true, status: 'active', balance: 5000, tenantId });
    const tx = await Transaction.create({
        customId: `MONITOR-TEST-${++serial}`, tenantId, status: 'processing', transferType: 'vodafone',
        amount: 100, costLYD: 20, vodafoneNumber: '01099887766', executorGroupId: group._id,
        notes: 'original customer note', createdAt: new Date(Date.now() - 600000),
        apiResultData: { providerTransactionId: '6103691', providerResultUnresolved: true, ...data }
    });
    return { tx, group };
};
beforeAll(async () => {
    database = await MongoMemoryServer.create();
    await mongoose.connect(database.getUri());
});
beforeEach(() => {
    envKeys.forEach((key) => { process.env[key] = 'true'; });
    getApiProviderTransaction.mockReset().mockResolvedValue(receipt());
});
afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([Transaction.deleteMany({}), ExecutorGroup.deleteMany({}), Notification.deleteMany({})]);
});
afterAll(async () => {
    monitor.stopApiPendingMonitor();
    for (const key of envKeys) {
        if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
    await mongoose.disconnect();
    await database.stop();
});

test('matched success records a review alert, never completes or changes money', async () => {
    const { tx, group } = await createPending();
    expect(await monitor.runPendingMonitorCycle()).toEqual({ checked: 1 });
    const stored = await Transaction.findById(tx._id).lean();
    expect(stored.status).toBe('processing');
    expect(stored.amount).toBe(100);
    expect(stored.costLYD).toBe(20);
    expect(stored.notes).toBe('original customer note');
    expect(stored.apiResultData.providerResultUnresolved).toBe(true);
    expect(stored.apiResultData.providerMonitorState).toBe('paid');
    expect(stored.apiResultData.providerMonitorStopped).toBe(true);
    expect((await ExecutorGroup.findById(group._id)).balance).toBe(5000);
    const alert = await Notification.findOne({ targetId: tx._id });
    expect(String(alert.tenantId)).toBe(String(tx.tenantId));
    expect(alert.audience).toBe('admin');
    expect(await monitor.runPendingMonitorCycle()).toEqual({ checked: 0 });
    expect(getApiProviderTransaction).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments()).toBe(1);
});

test('full reference waits with backoff and no repeated alerts', async () => {
    const { tx } = await createPending();
    getApiProviderTransaction.mockResolvedValue({ ...receipt(), referenceNumber: '01212345429' });
    await monitor.runPendingMonitorCycle();
    const stored = await Transaction.findById(tx._id);
    expect(stored.apiResultData.providerMonitorState).toBe('pending');
    expect(stored.apiResultData.providerMonitorNextCheckAt.getTime()).toBeGreaterThan(Date.now() + 290000);
    await monitor.runPendingMonitorCycle();
    expect(getApiProviderTransaction).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments()).toBe(0);
});

test.each([
    ['returned', { isReturned: true, providerStatus: 'ملغية' }],
    ['mismatch', { amount: 101 }],
    ['mismatch', { phone: '' }]
])('%s requires admin review without any cancellation', async (state, change) => {
    const { tx } = await createPending();
    getApiProviderTransaction.mockResolvedValue({ ...receipt(), ...change });
    await monitor.runPendingMonitorCycle();
    const stored = await Transaction.findById(tx._id);
    expect(stored.status).toBe('processing');
    expect(stored.apiResultData.providerMonitorState).toBe(state);
    expect(await Notification.countDocuments()).toBe(1);
});

test('missing provider id stops with a useful alert and no provider request', async () => {
    const { tx } = await createPending({ providerTransactionId: null });
    await monitor.runPendingMonitorCycle();
    expect((await Transaction.findById(tx._id)).apiResultData.providerMonitorState).toBe('missing_reference');
    expect(getApiProviderTransaction).not.toHaveBeenCalled();
    expect(await Notification.countDocuments()).toBe(1);
});

test('does not use executor credentials belonging to another tenant', async () => {
    const { tx, group } = await createPending();
    await ExecutorGroup.updateOne({ _id: group._id }, { $set: { tenantId: new mongoose.Types.ObjectId() } });
    await monitor.runPendingMonitorCycle();
    expect((await Transaction.findById(tx._id)).apiResultData.providerMonitorState).toBe('missing_executor');
    expect(getApiProviderTransaction).not.toHaveBeenCalled();
});

test('two concurrent claims issue one read only', async () => {
    const { tx } = await createPending();
    const outcomes = await Promise.all([monitor.checkPendingOperation(tx), monitor.checkPendingOperation(tx)]);
    expect(outcomes.filter((item) => item.checked)).toHaveLength(1);
    expect(getApiProviderTransaction).toHaveBeenCalledTimes(1);
});

test('discards a stale response when an administrator changed the row', async () => {
    const { tx } = await createPending();
    getApiProviderTransaction.mockImplementation(async () => {
        await Transaction.updateOne({ _id: tx._id }, { $set: { status: 'cancelled_by_admin' } });
        return receipt();
    });
    await monitor.runPendingMonitorCycle();
    const stored = await Transaction.findById(tx._id);
    expect(stored.status).toBe('cancelled_by_admin');
    expect(stored.apiResultData.providerMonitorState).toBeUndefined();
    expect(stored.apiResultData.providerMonitorLeaseToken).toBeUndefined();
    expect(await Notification.countDocuments()).toBe(0);
});

test('the eighth attempt halts automatically; failed checks preserve the last receipt', async () => {
    const { tx } = await createPending({ providerMonitorAttempts: 7, providerReportedReference: 'old-reference' });
    getApiProviderTransaction.mockRejectedValue(new Error('timeout'));
    await monitor.runPendingMonitorCycle();
    await monitor.runPendingMonitorCycle();
    const stored = await Transaction.findById(tx._id);
    expect(stored.apiResultData.providerMonitorAttempts).toBe(8);
    expect(stored.apiResultData.providerMonitorState).toBe('exhausted');
    expect(stored.apiResultData.providerReportedReference).toBe('old-reference');
    expect(getApiProviderTransaction).toHaveBeenCalledTimes(1);
});

test('internal alert outbox retries without duplicates or clearing read state', async () => {
    const { tx } = await createPending();
    await monitor.checkPendingOperation(tx);
    jest.spyOn(Notification, 'updateOne').mockRejectedValueOnce(new Error('temporary storage error'));
    await monitor.flushMonitorAlerts();
    expect((await Transaction.findById(tx._id)).apiResultData.providerMonitorAlertPending).toBe(true);
    await monitor.flushMonitorAlerts();
    await Notification.updateMany({}, { $set: { isRead: true } });
    await Transaction.updateOne({ _id: tx._id }, { $set: { 'apiResultData.providerMonitorAlertPending': true } });
    await monitor.flushMonitorAlerts();
    expect(await Notification.countDocuments()).toBe(1);
    expect((await Notification.findOne()).isRead).toBe(true);
});

test('repeated provider errors notify once until the retry limit changes the outcome', async () => {
    const { tx } = await createPending({ providerMonitorAttempts: 2, providerMonitorFailures: 2 });
    getApiProviderTransaction.mockResolvedValue({ success: false });
    await monitor.runPendingMonitorCycle();
    await Transaction.updateOne({ _id: tx._id }, { $set: { 'apiResultData.providerMonitorNextCheckAt': new Date(0) } });
    await monitor.runPendingMonitorCycle();
    expect(getApiProviderTransaction).toHaveBeenCalledTimes(2);
    expect(await Notification.countDocuments()).toBe(1);
    expect((await Transaction.findById(tx._id)).apiResultData.providerMonitorAttempts).toBe(4);
});

test('does not emit a stale outbox alert for a transaction resolved by an admin', async () => {
    const { tx } = await createPending();
    await monitor.checkPendingOperation(tx);
    await Transaction.updateOne({ _id: tx._id }, { $set: { status: 'completed' } });
    await monitor.flushMonitorAlerts();
    expect(await Notification.countDocuments()).toBe(0);
    expect((await Transaction.findById(tx._id)).apiResultData.providerMonitorAlertPending).toBe(false);
});

test.each(envKeys)('respects disabled switch %s', async (key) => {
    await createPending();
    process.env[key] = 'false';
    expect(await monitor.runPendingMonitorCycle()).toEqual({ skipped: true });
    expect(getApiProviderTransaction).not.toHaveBeenCalled();
});

test('limits a cycle to ten receipts and excludes fresh or completed operations', async () => {
    for (let index = 0; index < 11; index += 1) await createPending();
    const { tx: recent } = await createPending();
    await Transaction.updateOne({ _id: recent._id }, { $set: { createdAt: new Date() } }, { timestamps: false, overwriteImmutable: true });
    const { tx: completed } = await createPending();
    await Transaction.updateOne({ _id: completed._id }, { $set: { status: 'completed' } });
    expect(await Transaction.countDocuments(pendingProviderQuery())).toBe(11);
    expect(await monitor.runPendingMonitorCycle()).toEqual({ checked: 10 });
    expect(getApiProviderTransaction).toHaveBeenCalledTimes(10);
});
