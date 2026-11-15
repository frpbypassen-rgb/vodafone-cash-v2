'use strict';
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../models/Transaction', () => ({ updateOne: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../services/providerDispatchClaimService', () => ({
    UNRESOLVED_CODE: 'PROVIDER_RESULT_UNRESOLVED',
    claimProviderDispatch: jest.fn(async () => ({ claimed: true, attemptId: 'claim-1' })),
    releaseProviderDispatchClaim: jest.fn(async () => ({ released: true })),
    classifyPaymentTransportError: jest.fn(() => 'unresolved')
}));
const axios = require('axios');
const Transaction = require('../models/Transaction');
const dispatch = require('../services/providerDispatchClaimService');
const ExecutorGroup = require('../models/ExecutorGroup');
const api = require('../services/externalApiService');
const bot = { _id: 'executor-1', apiProviderKey: 'kenan', apiUrl: 'https://kenan.example', apiToken: 'fixture-secret' };
const tx = () => ({ _id: 'tx-1', customId: 'ATT-TEST', executorGroupId: 'executor-1', status: 'processing', transferType: 'vodafone', vodafoneNumber: '01000000000', amount: 50 });
const order = (status = 'queued', extra = {}) => ({ reference: '0000001', phone: '01000000000', amount_minor: 5000, fee_minor: null, status, created_at: '2026-11-14T12:00:00.000Z', reason: '', ...extra });
beforeEach(() => {
    jest.clearAllMocks(); process.env.EXTERNAL_API_ENABLED = 'true'; process.env.KENAN_AUTO_FOLLOWUP_ENABLED = 'true';
    delete process.env.APP_ENV; delete process.env.ENVIRONMENT;
    Transaction.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
});
test('Kenan acceptance preserves its zero-prefixed reference and stays pending', async () => {
    axios.post.mockResolvedValue({ data: order() });
    const result = await api.executeTransferViaApi(tx(), bot);
    expect(result).toMatchObject({ success: 'pending', providerPending: true, provider_transaction_id: '0000001' });
    expect(axios.post).toHaveBeenCalledWith('https://kenan.example/api/company/orders', { phone: '01000000000', amount_minor: 5000 }, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-secret' }), maxRedirects: 0 }));
    expect(Transaction.updateOne).toHaveBeenCalledWith(expect.objectContaining({ 'apiResultData.providerDispatchAttemptId': 'claim-1' }), expect.objectContaining({ $set: expect.objectContaining({ 'apiResultData.kenanReference': '0000001', 'apiResultData.kenanAwaitingStatus': true }) }), expect.anything());
});
test.each([49, 60001, 50.5, Infinity])('Kenan rejects invalid EGP amount %s before dispatch', async amount => {
    await expect(api.executeTransferViaApi({ ...tx(), amount }, bot)).resolves.toMatchObject({ success: false });
    expect(dispatch.claimProviderDispatch).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});
test('Kenan balance is converted from piastres to EGP', async () => {
    axios.get.mockResolvedValue({ data: { credit: 10000, reserved: 1000, available: 9000 } });
    await expect(api.getApiProviderBalance(bot)).resolves.toMatchObject({ success: true, serviceCredit: 100, reservedBalance: 10, availableBalance: 90 });
    expect(axios.post).not.toHaveBeenCalled();
});
test('preflight validates locally and checks balance without creating an order', async () => {
    axios.get.mockResolvedValue({ data: { credit: 10000, reserved: 0, available: 10000 } });
    await expect(api.runApiTransferPreflight(bot, { phone: '01000000000', amount: 50 })).resolves.toMatchObject({ success: true, stage: 'completed' });
    expect(axios.post).not.toHaveBeenCalled();
});
test('an ambiguous POST timeout holds the dispatch and never repeats it', async () => {
    axios.post.mockRejectedValue({ code: 'ETIMEDOUT', message: 'contains fixture-secret' });
    const result = await api.executeTransferViaApi(tx(), bot);
    expect(result.success).toBe('unresolved');
    expect(dispatch.releaseProviderDispatchClaim).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
});
test('runtime switch blocks Kenan before every outbound request', async () => {
    process.env.EXTERNAL_API_ENABLED = 'false';
    await expect(api.executeTransferViaApi(tx(), bot)).resolves.toMatchObject({ success: false, code: 'EXTERNAL_API_DISABLED' });
    expect(axios.post).not.toHaveBeenCalled(); expect(axios.get).not.toHaveBeenCalled();
});

describe('durable Kenan status polling', () => {
    const service = require('../services/kenanProviderService');
    let row;
    beforeEach(() => {
        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
        row = { ...tx(), apiResultData: { kenanReference: '0000001', kenanAwaitingStatus: true, providerResultUnresolved: true,
            providerDispatchAttemptId: 'claim-1', providerDispatchResult: 'kenan_pending' } };
        Transaction.find.mockReturnValue({ sort: () => ({ limit: async () => [row] }) });
        Transaction.findOneAndUpdate.mockResolvedValue(row);
        ExecutorGroup.findById.mockResolvedValue(bot);
    });
    test.each(['queued', 'assigned', 'executing', 'verifying', 'review'])('%s never schedules financial completion', async status => {
        axios.get.mockResolvedValue({ data: order(status) });
        await service.pollPendingOrders();
        const patch = Transaction.updateOne.mock.calls[0][1].$set;
        expect(patch['apiResultData.kenanProviderStatus']).toBe(status);
        expect(patch['apiResultData.waitingApiAutoCompletion']).toBeUndefined();
        expect(patch.status).toBeUndefined();
        expect(axios.post).not.toHaveBeenCalled();
    });
    test('only an authoritative matching success schedules common atomic completion', async () => {
        axios.get.mockResolvedValue({ data: order('success') });
        await service.pollPendingOrders();
        expect(Transaction.updateOne).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing', 'apiResultData.kenanReference': '0000001', 'apiResultData.providerDispatchResult': 'kenan_pending' }),
            { $set: expect.objectContaining({ 'apiResultData.kenanProviderStatus': 'success', 'apiResultData.waitingApiAutoCompletion': true,
                'apiResultData.providerResultUnresolved': false, 'apiResultData.providerDispatchResult': 'accepted' }) }, expect.anything());
    });
    test.each(['failed', 'cancelled'])('%s returns to administration with no client refund or executor debit', async status => {
        axios.get.mockResolvedValue({ data: order(status) });
        await service.pollPendingOrders();
        expect(Transaction.updateOne.mock.calls[0][1]).toMatchObject({ $set: { status: 'pending', 'apiResultData.kenanAwaitingStatus': false, 'apiResultData.providerDispatchResult': 'rejected' }, $unset: { executorGroupId: '' } });
        expect(axios.post).not.toHaveBeenCalled();
    });
    test.each([{ phone: '01111111111' }, { amount_minor: 10000 }, { reference: '0000002' }, { status: 'unknown' }])('mismatched or malformed response %j retains the hold', async extra => {
        axios.get.mockResolvedValue({ data: order('success', extra) });
        await service.pollPendingOrders();
        expect(Transaction.updateOne).not.toHaveBeenCalled();
    });
    test('another worker holding the poll lease prevents duplicate status handling', async () => {
        Transaction.findOneAndUpdate.mockResolvedValue(null);
        await service.pollPendingOrders();
        expect(axios.get).not.toHaveBeenCalled();
    });
    test('independent Kenan switch disables polling even when global financial scheduling is on', async () => {
        process.env.KENAN_AUTO_FOLLOWUP_ENABLED = 'false';
        await service.pollPendingOrders();
        expect(Transaction.find).not.toHaveBeenCalled();
    });
    test('Kenan polling continues while unrelated financial schedulers are off', async () => {
        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
        axios.get.mockResolvedValue({ data: order('assigned') });
        await service.pollPendingOrders();
        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(process.env.FINANCIAL_SCHEDULERS_ENABLED).toBe('false');
    });
});

test('a documented HTTP rejection releases the claim without retrying', async () => {
    dispatch.classifyPaymentTransportError.mockReturnValueOnce('definitive_rejection');
    axios.post.mockRejectedValue({ response: { status: 429, data: { retry_after_seconds: 300 } } });
    await expect(api.executeTransferViaApi(tx(), bot)).resolves.toMatchObject({ success: false, dispatchReleased: true });
    expect(dispatch.releaseProviderDispatchClaim).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledTimes(1);
});
test('staging refuses the production host before transmission', async () => {
    process.env.APP_ENV = 'staging';
    await api.executeTransferViaApi(tx(), bot);
    expect(axios.post).not.toHaveBeenCalled();
    expect(dispatch.claimProviderDispatch).not.toHaveBeenCalled();
});
