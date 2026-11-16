'use strict';
jest.mock('axios', () => ({ post: jest.fn() }));
let axios;
let client;
beforeEach(() => {
    jest.resetModules();
    process.env.EXTERNAL_API_ENABLED = 'true';
    process.env.ZAYN_AGGREGATOR_URL = 'https://provider.test';
    process.env.ZAYN_USERNAME = 'isolated-user';
    process.env.ZAYN_PASSWORD = 'isolated-password';
    axios = require('axios');
    client = require('../services/zaynpayApi');
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const token = value => ({ data: { Code: 200, Data: { Access_Token: value } } });

test('direct inquiry calls share the provider throttle instead of sending a login for every attempt', async () => {
    axios.post.mockRejectedValue({ response: { status: 429, headers: { 'retry-after': '120' } } });
    for (let i = 0; i < 5; i++) await expect(client.inquiry('01012345678', 100)).rejects.toThrow();
    expect(axios.post).toHaveBeenCalledTimes(1);
});

test('the direct client and aggregator share one login for identical account settings', async () => {
    axios.post.mockImplementation(async url => url.endsWith('/GetToken') ? token('shared')
        : url.endsWith('/GetBalance') ? { data: { Code: 200, Data: { AvailableBalance: 1000 } } }
            : { data: { Code: 200, Data: { PaymentBillInfo: 'bill' } } });
    const api = require('../services/externalApiService');
    await api.getApiProviderBalance({ apiProviderKey: 'zayn_external_aggregator', apiUrl: process.env.ZAYN_AGGREGATOR_URL,
        apiUsername: process.env.ZAYN_USERNAME, apiPassword: process.env.ZAYN_PASSWORD });
    await client.inquiry('01012345678', 100);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/GetToken'))).toHaveLength(1);
});

test('the direct client observes the shared token expiry instead of caching its own token indefinitely', async () => {
    let now = Date.now(), logins = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    axios.post.mockImplementation(async url => url.endsWith('/GetToken') ? token('token-' + (++logins))
        : { data: { Code: 200, Data: { PaymentBillInfo: 'bill' } } });
    await client.inquiry('01012345678', 100);
    now += 5 * 60 * 1000 + 1;
    await client.inquiry('01012345678', 100);
    expect(logins).toBe(2);
});

test('refreshes a rejected HTTP 401 inquiry once and uses bounded requests', async () => {
    axios.post.mockResolvedValueOnce(token('old')).mockRejectedValueOnce({ response: { status: 401 } })
        .mockResolvedValueOnce(token('new')).mockResolvedValueOnce({ data: { Code: 200, Data: { PaymentBillInfo: 'bill' } } });
    await expect(client.inquiry('01012345678', 100)).resolves.toBe('bill');
    for (const [, , options] of axios.post.mock.calls) {
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.maxRedirects).toBe(0);
    }
});

test('does not automatically resubmit Payment after an authentication-looking reply', async () => {
    axios.post.mockResolvedValueOnce(token('old')).mockResolvedValueOnce({ data: { Code: 401 } })
        .mockResolvedValueOnce(token('new')).mockResolvedValueOnce({ data: { Code: 200, Data: { RefTransactionNumber: 'ref' } } });
    await client.pay('bill', '01012345678', 100);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/Payment'))).toHaveLength(1);
});

test('accepts string success codes but requires a usable inquiry bill', async () => {
    axios.post.mockResolvedValueOnce({ data: { Code: '200', Data: { Access_Token: 'token' } } })
        .mockResolvedValueOnce({ data: { Code: '200', Data: {} } });
    await expect(client.inquiry('01012345678', 100)).rejects.toThrow();
    expect(client.token).toBe('token');
});

test('provider response secrets stay out of error logs and client errors', async () => {
    axios.post.mockRejectedValueOnce({ response: { data: { Message: 'private-provider-password' } } });
    await expect(client.inquiry('01012345678', 100)).rejects.toThrow();
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('private-provider-password');
});

test('changing provider credentials cannot reuse the previous identity token', async () => {
    axios.post.mockResolvedValueOnce(token('identity-one')).mockResolvedValueOnce({ data: { Code: 200, Data: { PaymentBillInfo: 'bill-one' } } })
        .mockResolvedValueOnce(token('identity-two')).mockResolvedValueOnce({ data: { Code: 200, Data: { PaymentBillInfo: 'bill-two' } } });
    await client.inquiry('01012345678', 100);
    process.env.ZAYN_PASSWORD = 'changed-isolated-password';
    await client.inquiry('01012345678', 100);
    const inquiries = axios.post.mock.calls.filter(([url]) => url.endsWith('/Inquiry'));
    expect(inquiries.map(([, , options]) => options.headers.Authorization)).toEqual(['Bearer identity-one', 'Bearer identity-two']);
    expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/GetToken'))).toHaveLength(2);
});

test('paid flag without any provider reference stays unresolved', async () => {
    axios.post.mockResolvedValueOnce(token('token')).mockResolvedValueOnce({ data: { Code: 200, Data: { IsPaid: true } } });
    expect(await client.pay('bill', '01012345678', 100)).toMatchObject({ success: false, unresolved: true });
});
test('extracts a reference returned inside PrintBill', async () => {
    axios.post.mockResolvedValueOnce(token('token')).mockResolvedValueOnce({ data: { Code: 200, Data: { PrintBill: { RefNumber: '010****123', TransactionId: 'provider-123' } } } });
    expect(await client.pay('bill', '01012345678', 100)).toMatchObject({ success: true, refNumber: '010****123', transactionNumber: 'provider-123' });
});
