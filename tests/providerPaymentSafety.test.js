'use strict';

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../services/providerDispatchClaimService', () => ({
    UNRESOLVED_CODE: 'PROVIDER_RESULT_UNRESOLVED',
    saveZaynReply: jest.fn(async (tx, _id, fields) => { Object.assign(tx.apiResultData, fields); }),
    claimProviderDispatch: jest.fn(async tx => {
        tx.apiResultData = { providerDispatchAttemptId: 'attempt-1' };
        return { claimed: true, attemptId: 'attempt-1' };
    }),
    releaseProviderDispatchClaim: jest.fn(async () => ({ released: true })),
    classifyPaymentTransportError: jest.fn(() => 'unresolved')
}));
const axios = require('axios');
const { executeTransferViaApi, getApiProviderBalance, getApiProviderTransactions } = require('../services/externalApiService');
const { releaseProviderDispatchClaim } = require('../services/providerDispatchClaimService');
const provider = { apiUrl: 'https://provider.test', apiToken: 'isolated-token' };
beforeEach(() => {
    require('../services/providerAuthSessionService').clearProviderAuthSessions();
    jest.clearAllMocks();
    axios.post.mockReset();
    process.env.EXTERNAL_API_ENABLED = 'true';
});

test.each([
    ['empty success', { Code: 200, Data: {} }],
    ['missing body', null],
    ['HTML gateway response', '<html>gateway error</html>'],
    ['internal provider error', { Code: 500, Message: 'error' }],
    ['string false paid flag', { Code: 200, Data: { IsPaid: 'false', RefTransactionNumber: '010****123' } }],
    ['string true failure flag', { Code: 200, Data: { IsFailure: 'true', RefTransactionNumber: '010****123' } }],
    ['returned masked reference', { Code: 200, Data: { Status: 'تم الاسترجاع', RefTransactionNumber: '010****123' } }],
])('holds %s after Payment instead of releasing it for another payment', async (_name, body) => {
    axios.post.mockResolvedValueOnce({ data: { Code: 200, Data: { PaymentBillInfo: 'bill' } } })
        .mockResolvedValueOnce({ data: body });
    const result = await executeTransferViaApi({ _id: 'tx-1', executorGroupId: 'group-1', amount: 100, vodafoneNumber: '01012345678' }, provider);
    expect(['unresolved', 'pending']).toContain(result.success);
    expect(releaseProviderDispatchClaim).not.toHaveBeenCalled();
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/Payment'))).toHaveLength(1);
});

test('all payment requests prevent redirect-based resubmission', async () => {
    axios.post.mockResolvedValueOnce({ data: { Code: 200, Data: { PaymentBillInfo: 'bill' } } })
        .mockResolvedValueOnce({ data: { Code: 200, Data: { RefTransactionNumber: '010****123' } } });
    await executeTransferViaApi({ _id: 'tx-1', executorGroupId: 'group-1', amount: 100, vodafoneNumber: '01012345678' }, provider);
    for (const [, , options] of axios.post.mock.calls) expect(options.maxRedirects).toBe(0);
});

test('malformed balance data fails validation rather than inventing a zero balance', async () => {
    axios.post.mockResolvedValue({ data: { Code: 200, Data: {} } });
    expect((await getApiProviderBalance(provider)).success).toBe(false);
});

test('receipt lookup accepts numeric-string success codes', async () => {
    axios.post.mockResolvedValue({ data: { Code: '200', Data: { TransactionId: '123', Amount: 100 } } });
    expect((await getApiProviderTransactions(provider, ['123'])).operations[0].success).toBe(true);
});

test.each([null, {}, ' '])('rejects malformed authentication tokens before Inquiry or Payment: %j', async badToken => {
    axios.post.mockResolvedValueOnce({ data: { Code: 200, Data: { Access_Token: badToken } } });
    const result = await executeTransferViaApi({ _id: 'tx-1', executorGroupId: 'group-1', amount: 100, vodafoneNumber: '01012345678' },
        { apiUrl: 'https://provider.test', apiUsername: 'test-user', apiPassword: 'test-password' });
    expect(result.success).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(1);
});

test('a masked receipt with an explicit pending state is held and raw provider fields are not logged', async () => {
    axios.post.mockResolvedValueOnce({data:{Code:200,Data:{PaymentBillInfo:'test-bill'}}})
        .mockResolvedValueOnce({status:200,data:{Code:200,Data:{Status:'pending',TransactionId:'00042',
            RefNumber:'010****123', ExtraDiagnostic:'PRIVATE_FIXTURE_ONLY'}}});
    const result = await executeTransferViaApi({_id:'tx-1',executorGroupId:'group-1',amount:100,vodafoneNumber:'01012345678'}, provider);
    expect(result.success).toBe('pending');
    expect(result.provider_transaction_id).toBe('00042');
    expect(result.processLog).not.toContain('PRIVATE_FIXTURE_ONLY');
    expect(result.processLog).not.toContain('01012345678');
    expect(axios.post).toHaveBeenCalledTimes(2);
});

test('a success-shaped Payment response for a different amount cannot settle the transfer', async () => {
    axios.post.mockResolvedValueOnce({data:{Code:200,Data:{PaymentBillInfo:'test-bill'}}})
        .mockResolvedValueOnce({status:200,data:{Code:200,Data:{Amount:101,Status:'paid',TransactionId:'00043',RefNumber:'010****123'}}});
    const result=await executeTransferViaApi({_id:'tx-1',executorGroupId:'group-1',amount:100,vodafoneNumber:'01012345678'},provider);
    expect(result.success).toBe('unresolved');
    expect(releaseProviderDispatchClaim).not.toHaveBeenCalled();
});
