'use strict';
jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/providerDispatchClaimService', () => ({
    ...jest.requireActual('../services/providerDispatchClaimService'),
    claimProviderDispatch: jest.fn(async tx => { tx.apiResultData = { providerDispatchAttemptId: 'test-attempt' }; return { claimed: true, attemptId: 'test-attempt' }; }),
    releaseProviderDispatchClaim: jest.fn(async () => ({ released: true }))
}));
let axios, api;
const config = { apiUrl: 'https://provider.test', apiUsername: 'isolated-user', apiPassword: 'isolated-password' };
const token = value => ({ data: { Code: 200, Data: { Access_Token: value } } });
const balance = { data: { Code: 200, Data: { AvailableBalance: 1000 } } };
beforeEach(() => {
    jest.resetModules();
    process.env.EXTERNAL_API_ENABLED = 'true';
    delete process.env.ZAYN_API_TOKEN; delete process.env.ZAYNPAY_API_TOKEN;
    axios = require('axios'); api = require('../services/externalApiService');
});
afterEach(() => jest.restoreAllMocks());
test('balance, inquiry and receipt reads reuse one account login', async () => {
    axios.post.mockImplementation(async url => url.endsWith('/GetToken') ? token('shared-token')
        : url.endsWith('/GetBalance') ? balance : { data: { Code: 200, Data: { TransactionId: '123', Amount: 100 } } });
    await api.getApiProviderBalance(config); await api.getApiProviderBalance(config);
    await api.getApiProviderTransactions(config, ['123']);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/GetToken'))).toHaveLength(1);
});
test('50 simultaneous balance checks coalesce login requests', async () => {
    axios.post.mockImplementation(async url => url.endsWith('/GetToken') ? token('shared-token') : balance);
    const results = await Promise.all(Array.from({ length: 50 }, () => api.getApiProviderBalance(config)));
    expect(results.every(result => result.success)).toBe(true);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/GetToken'))).toHaveLength(1);
});
test.each(['http', 'business', 'message', 'error', 'text'])('%s throttling blocks subsequent logins until Retry-After expires', async mode => {
    let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
    axios.post.mockImplementation(async () => {
        const response = { status: mode === 'http' ? 429 : 200, headers: { 'retry-after': '120' }, data: { Code: mode === 'business' ? 429 : 200, Message: 'Too many attempts. Please try again later.' } };
        if (mode === 'error') response.data = { error: 'Too many attempts. Please try again later.' };
        if (mode === 'text') response.data = 'Too many attempts. Please try again later.';
        if (mode === 'http') throw { response };
        return response;
    });
    await api.getApiProviderBalance(config);
    await api.getApiProviderBalance(config);
    expect(axios.post).toHaveBeenCalledTimes(1);
    now += 119000; await api.getApiProviderBalance(config);
    expect(axios.post).toHaveBeenCalledTimes(1);
    now += 2000; axios.post.mockImplementation(async url => url.endsWith('/GetToken') ? token('recovered') : balance);
    expect((await api.getApiProviderBalance(config)).success).toBe(true);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/GetToken'))).toHaveLength(2);
});
test('credential changes do not reuse an earlier identity token', async () => {
    let count = 0;
    axios.post.mockImplementation(async url => url.endsWith('/GetToken') ? token('identity-' + (++count)) : balance);
    await api.getApiProviderBalance(config); await api.getApiProviderBalance({ ...config, apiPassword: 'changed-password' });
    expect(count).toBe(2);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/GetBalance')).map(([, , options]) => options.headers.Authorization)).toEqual(['Bearer identity-1', 'Bearer identity-2']);
});
test('an expired cached token refreshes a read once without repeated authentication on success', async () => {
    let logins = 0, reads = 0;
    axios.post.mockImplementation(async url => {
        if (url.endsWith('/GetToken')) return token('token-' + (++logins));
        if (++reads === 2) throw { response: { status: 401 } };
        return balance;
    });
    await api.getApiProviderBalance(config);
    expect((await api.getApiProviderBalance(config)).success).toBe(true);
    expect(logins).toBe(2); expect(reads).toBe(3);
});

test('the full balance, inquiry, Payment and post-balance sequence authenticates once', async () => {
    axios.post.mockImplementation(async url => url.endsWith('/GetToken') ? token('single-login')
        : url.endsWith('/GetBalance') ? balance : url.endsWith('/Inquiry') ? { data: { Code: 200, Data: { PaymentBillInfo: 'bill' } } }
        : { data: { Code: 200, Data: { TransactionId: 'provider-1', RefNumber: '010****678' } } });
    await api.getApiProviderBalance(config);
    const result = await api.executeTransferViaApi({ _id: 'operation-1', executorGroupId: 'group-1', amount: 100, vodafoneNumber: '01012345678' }, config);
    await api.getApiProviderBalance(config);
    expect(result.success).toBe(true);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/GetToken'))).toHaveLength(1);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/Payment'))).toHaveLength(1);
});
test('a Payment HTTP 401 invalidates the session for later reads but never resends Payment', async () => {
    let logins = 0;
    axios.post.mockImplementation(async url => {
        if (url.endsWith('/GetToken')) return token('token-' + (++logins));
        if (url.endsWith('/Inquiry')) return { data: { Code: 200, Data: { PaymentBillInfo: 'bill' } } };
        if (url.endsWith('/Payment')) throw { response: { status: 401 } };
        return balance;
    });
    const result = await api.executeTransferViaApi({ _id: 'operation-1', executorGroupId: 'group-1', amount: 100, vodafoneNumber: '01012345678' }, config);
    expect(result.success).toBe('unresolved'); expect(logins).toBe(1);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/Payment'))).toHaveLength(1);
    await api.getApiProviderBalance(config); expect(logins).toBe(2);
});

test('opaque tokens have a bounded cache lifetime', async () => {
    let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
    let logins = 0;
    axios.post.mockImplementation(async url => url.endsWith('/GetToken') ? token('token-' + (++logins)) : balance);
    await api.getApiProviderBalance(config); now += 5 * 60 * 1000 + 1;
    await api.getApiProviderBalance(config); expect(logins).toBe(2);
});

test('JWT expiry limits the cache lifetime before the five-minute ceiling', async () => {
    let now = 1800000000000; jest.spyOn(Date, 'now').mockImplementation(() => now);
    let logins = 0;
    axios.post.mockImplementation(async url => {
        if (!url.endsWith('/GetToken')) return balance;
        logins++;
        return token('header.' + Buffer.from(JSON.stringify({ exp: now / 1000 + 60 })).toString('base64url') + '.signature');
    });
    await api.getApiProviderBalance(config); now += 44000;
    await api.getApiProviderBalance(config); expect(logins).toBe(1);
    now += 2000; await api.getApiProviderBalance(config); expect(logins).toBe(2);
});

test('an HTTP-date Retry-After prevents login for the entire provider interval', async () => {
    let now = 1800000000000; jest.spyOn(Date, 'now').mockImplementation(() => now);
    axios.post.mockRejectedValue({ response: { status: 429, headers: { 'retry-after': new Date(now + 180000).toUTCString() } } });
    await api.getApiProviderBalance(config); now += 120000;
    const result = await api.getApiProviderBalance(config);
    expect(result).toMatchObject({ code: 'PROVIDER_AUTH_RATE_LIMITED', retryAfterSeconds: 60 });
    expect(axios.post).toHaveBeenCalledTimes(1);
});
test('authentication throttling before Inquiry never acquires a payment claim or sends Payment', async () => {
    axios.post.mockRejectedValue({ response: { status: 429, headers: { 'retry-after': '60' } } });
    const tx = { _id: 'operation-1', executorGroupId: 'group-1', amount: 100, vodafoneNumber: '01012345678' };
    const first = await api.executeTransferViaApi(tx, config);
    const second = await api.executeTransferViaApi(tx, config);
    expect(first).toMatchObject({ success: false, code: 'PROVIDER_AUTH_RATE_LIMITED' });
    expect(second).toMatchObject({ success: false, code: 'PROVIDER_AUTH_RATE_LIMITED' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(require('../services/providerDispatchClaimService').claimProviderDispatch).not.toHaveBeenCalled();
});
