'use strict';
jest.mock('../services/providerDispatchClaimService', () => ({
    ...jest.requireActual('../services/providerDispatchClaimService'),
    claimProviderDispatch: jest.fn(async tx => { tx.apiResultData = { providerDispatchAttemptId: 'isolated' }; return { claimed: true, attemptId: 'isolated' }; })
}));
jest.mock('../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const http = require('node:http');
const api = require('../services/externalApiService');
const { clearProviderAuthSessions } = require('../services/providerAuthSessionService');
let server, config, mode, logins, payments, reads;
beforeAll(async () => {
    process.env.EXTERNAL_API_ENABLED = 'true'; delete process.env.ZAYN_API_TOKEN; delete process.env.ZAYNPAY_API_TOKEN;
    server = http.createServer((req, res) => {
        req.resume(); req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url.endsWith('/GetToken')) {
                logins++;
                if (mode === 'throttled') { res.statusCode = 429; res.setHeader('Retry-After', '120'); return res.end(JSON.stringify({ message: 'Too many attempts' })); }
                return res.end(JSON.stringify({ Code: 200, Data: { Access_Token: 'isolated-token' } }));
            }
            if (req.url.endsWith('/GetBalance')) { reads++; return res.end(JSON.stringify({ Code: 200, Data: { AvailableBalance: 1000 } })); }
            if (req.url.endsWith('/Inquiry')) return res.end(JSON.stringify({ Code: 200, Data: { PaymentBillInfo: 'isolated-bill' } }));
            payments++; res.end(JSON.stringify({ Code: 200, Data: { TransactionId: 'isolated-1', RefNumber: '010****678' } }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    config = { apiUrl: 'http://127.0.0.1:' + server.address().port, apiUsername: 'isolated-user', apiPassword: 'isolated-password' };
});
afterAll(async () => { clearProviderAuthSessions(); await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { clearProviderAuthSessions(); mode = 'success'; logins = payments = reads = 0; });
test('real HTTP before-balance, Inquiry, Payment and after-balance use one login', async () => {
    await api.getApiProviderBalance(config);
    const result = await api.executeTransferViaApi({ _id: 'isolated-operation', executorGroupId: 'isolated-group', amount: 100, vodafoneNumber: '01012345678' }, config);
    await api.getApiProviderBalance(config);
    expect(result.success).toBe(true);
    expect({ logins, payments, reads }).toEqual({ logins: 1, payments: 1, reads: 2 });
});
test('real HTTP 429 prevents repeated login requests and sends no payment', async () => {
    mode = 'throttled';
    const results = await Promise.all(Array.from({ length: 20 }, () => api.getApiProviderBalance(config)));
    expect(results.every(result => result.code === 'PROVIDER_AUTH_RATE_LIMITED')).toBe(true);
    await api.getApiProviderBalance(config);
    expect({ logins, payments, reads }).toEqual({ logins: 1, payments: 0, reads: 0 });
});
