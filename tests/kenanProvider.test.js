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
    axios.get.mockReset().mockResolvedValue({ data: { credit: 10000, reserved: 0, available: 10000 } });
    delete process.env.APP_ENV; delete process.env.ENVIRONMENT;
    Transaction.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
});
test('Kenan acceptance preserves its zero-prefixed reference and stays pending', async () => {
    axios.post.mockResolvedValue({ data: order() });
    const result = await api.executeTransferViaApi(tx(), bot);
    expect(result).toMatchObject({ success: 'pending', providerPending: true, provider_transaction_id: '0000001' });
    expect(axios.post).toHaveBeenCalledWith('https://kenan.example/api/company/orders', { phone: '01000000000', amount: 50 }, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-secret' }), maxRedirects: 0 }));
    expect(Transaction.updateOne).toHaveBeenCalledWith(expect.objectContaining({ 'apiResultData.providerDispatchAttemptId': 'claim-1' }), expect.objectContaining({ $set: expect.objectContaining({ 'apiResultData.kenanReference': '0000001', 'apiResultData.kenanAwaitingStatus': true }) }), expect.anything());
});
test.each([49, 60001, 50.5, Infinity])('Kenan rejects invalid EGP amount %s before dispatch', async amount => {
    await expect(api.executeTransferViaApi({ ...tx(), amount }, bot)).resolves.toMatchObject({ success: false });
    expect(dispatch.claimProviderDispatch).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled();
});
test.each([50, 100, 60000])('v7 sends exactly integer pounds without a second conversion: %s EGP', async (amount) => {
    axios.post.mockResolvedValue({ data: order('queued', { amount_minor: amount * 100 }) });
    expect(await api.executeTransferViaApi({ ...tx(), amount }, bot)).toMatchObject({ success: 'pending' });
    expect(axios.post.mock.calls[0][1]).toEqual({ phone: '01000000000', amount });
});
test('a mismatching acceptance amount remains unresolved and cannot authorize settlement', async () => {
    axios.post.mockResolvedValue({ status:200, data: order('success', { amount_minor: 10000 }) });
    expect(await api.executeTransferViaApi(tx(), bot)).toMatchObject({ success: 'unresolved' });
    expect(dispatch.releaseProviderDispatchClaim).not.toHaveBeenCalled();
    expect(Transaction.updateOne.mock.calls[0][1].$set).toEqual({
        'apiResultData.kenanCreateReplyState':'unknown', 'apiResultData.kenanCreateHttpStatus':200,
        'apiResultData.kenanCreateReplyAt':expect.any(Date)
    });
});
test('Kenan balance is converted from piastres to EGP', async () => {
    axios.get.mockResolvedValue({ data: { credit: 10000, reserved: 1000, available: 9000 } });
    await expect(api.getApiProviderBalance(bot)).resolves.toMatchObject({ success: true, serviceCredit: 100, reservedBalance: 10, availableBalance: 90 });
    expect(axios.post).not.toHaveBeenCalled();
});
test('surrounding whitespace and an existing Bearer prefix do not duplicate authorization', async () => {
    await expect(api.getApiProviderBalance({ ...bot, apiToken: '  Bearer fixture-secret  ' })).resolves.toMatchObject({ success: true });
    expect(axios.get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-secret' }) }));
});
test('preflight calls the provider eligibility endpoint with integer pounds without creating an order', async () => {
    axios.post.mockResolvedValue({ data: { eligible: true, phone: '01000000000', amount_minor: 5000, available_minor: 10000 } });
    await expect(api.runApiTransferPreflight(bot, { phone: '01000000000', amount: 50 })).resolves.toMatchObject({ success: true, stage: 'completed' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith('https://kenan.example/api/company/orders/check', { phone: '01000000000', amount: 50 }, expect.anything());
    expect(dispatch.claimProviderDispatch).not.toHaveBeenCalled();
    expect(Transaction.updateOne).not.toHaveBeenCalled();
});

test.each([{ phone: '01111111111' }, { amount_minor: 5100 }, { eligible: 'true' }, { available_minor: 4999 }])('invalid or mismatching eligibility response fails closed: %j', async (extra) => {
    axios.post.mockResolvedValue({ data: { eligible: true, phone: '01000000000', amount_minor: 5000, available_minor: 10000, ...extra } });
    await expect(api.runApiTransferPreflight(bot, { phone: '01000000000', amount: 50 })).resolves.toMatchObject({ success: false });
    expect(dispatch.claimProviderDispatch).not.toHaveBeenCalled();
});

test('provider eligibility cooldown preserves Retry-After and never sends a payment', async () => {
    axios.post.mockRejectedValue({ response: { status: 429, data: { retry_after_seconds: 120 } } });
    await expect(api.runApiTransferPreflight(bot, { phone: '01000000000', amount: 50 })).resolves.toMatchObject({ success: false, retryAfterSeconds: 120 });
    expect(dispatch.claimProviderDispatch).not.toHaveBeenCalled();
});
test('an ambiguous POST timeout holds the dispatch and never repeats it', async () => {
    axios.post.mockRejectedValue({ code: 'ETIMEDOUT', message: 'contains fixture-secret' });
    const result = await api.executeTransferViaApi(tx(), bot);
    expect(result.success).toBe('unresolved');
    expect(dispatch.releaseProviderDispatchClaim).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(Transaction.updateOne.mock.calls[0][1].$set).toMatchObject({
        'apiResultData.kenanCreateReplyState':'unknown', 'apiResultData.kenanCreateHttpStatus':null
    });
});
test.each([[401,'definitive_rejection','rejected',true],[503,'unresolved','unknown',false]])('records HTTP %i against the active claim before release or hold', async (status, classification, reply, released) => {
    dispatch.classifyPaymentTransportError.mockReturnValueOnce(classification);
    axios.post.mockRejectedValueOnce({response:{status,data:{message:'upstream-private'}}});
    const result = await api.executeTransferViaApi(tx(), bot);
    const [filter,update,options] = Transaction.updateOne.mock.calls[0];
    expect(filter).toMatchObject({_id:'tx-1',status:'processing',executorGroupId:'executor-1','apiResultData.providerDispatchAttemptId':'claim-1',
        'apiResultData.providerResolutionOutcome':{$exists:false}});
    expect(update.$set).toEqual({'apiResultData.kenanCreateReplyState':reply, 'apiResultData.kenanCreateHttpStatus':status,
        'apiResultData.kenanCreateReplyAt':expect.any(Date)});
    expect(options.writeConcern.w).toBe('majority');
    expect(Boolean(result.dispatchReleased)).toBe(released);
    if(released) expect(Transaction.updateOne.mock.invocationCallOrder[0]).toBeLessThan(dispatch.releaseProviderDispatchClaim.mock.invocationCallOrder[0]);
    expect(axios.post).toHaveBeenCalledTimes(1);
});
test('a concurrent claim change prevents release even on a definitive upstream rejection', async () => {
    dispatch.classifyPaymentTransportError.mockReturnValueOnce('definitive_rejection');
    axios.post.mockRejectedValueOnce({response:{status:401}});
    Transaction.updateOne.mockResolvedValueOnce({matchedCount:0});
    expect((await api.executeTransferViaApi(tx(),bot)).success).toBe('unresolved');
    expect(dispatch.releaseProviderDispatchClaim).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);
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
        row = { ...tx(), updatedAt: new Date(), apiResultData: { kenanReference: '0000001', kenanAwaitingStatus: true, providerResultUnresolved: true,
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
        expect(Transaction.updateOne).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing', 'apiResultData.kenanReference': '0000001', updatedAt: row.updatedAt,
            'apiResultData.providerResultUnresolved': true, 'apiResultData.providerResolutionOutcome': { $exists: false } }),
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
        axios.get.mockResolvedValue({ status:200, data: order('success', extra) });
        await service.pollPendingOrders();
        const [guard, update] = Transaction.updateOne.mock.calls[0];
        expect(guard).toMatchObject({'apiResultData.kenanReference':'0000001',updatedAt:row.updatedAt});
        expect(update.$set).toEqual({
            'apiResultData.kenanLastPollAt':expect.any(Date), 'apiResultData.kenanLastPollOutcome':'mismatch',
            'apiResultData.kenanLastPollHttpStatus':200, 'apiResultData.kenanNextPollAt':expect.any(Date)
        });
        expect(axios.post).not.toHaveBeenCalled();
    });
    test('a read throttle persists the next attempt and preserves the last verified receipt', async () => {
        axios.get.mockRejectedValue({response:{status:429,headers:{'retry-after':'240'}}});
        const start=Date.now();
        await service.pollPendingOrders();
        const patch=Transaction.updateOne.mock.calls[0][1].$set;
        expect(patch).toMatchObject({'apiResultData.kenanLastPollOutcome':'unavailable','apiResultData.kenanLastPollHttpStatus':429});
        expect(patch['apiResultData.kenanNextPollAt'].getTime()).toBeGreaterThanOrEqual(start+240000);
        expect(patch['apiResultData.kenanProviderStatus']).toBeUndefined();
        expect(axios.post).not.toHaveBeenCalled();
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
