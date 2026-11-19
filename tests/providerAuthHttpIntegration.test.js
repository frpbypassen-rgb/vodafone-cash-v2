'use strict';
jest.mock('../services/providerDispatchClaimService', () => ({
    ...jest.requireActual('../services/providerDispatchClaimService'),
    saveZaynReply: jest.fn(async (tx, _id, fields) => { Object.assign(tx.apiResultData, fields); }),
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
                if (mode === 'auth-network-reset') return req.socket.destroy();
                if (mode === 'throttled') { res.statusCode = 429; res.setHeader('Retry-After', '120'); return res.end(JSON.stringify({ message: 'Too many attempts' })); }
                const accessToken = mode === 'long-jwt'
                    ? 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url') + '.signature'
                    : 'isolated-token';
                return res.end(JSON.stringify({ Code: 200, Data: { Access_Token: accessToken } }));
            }
            if (req.url.endsWith('/Print')) {
                reads++;
                if (mode === 'print-network-reset') return req.socket.destroy();
                if (mode === 'print-business-error') return res.end(JSON.stringify({ Code:422, Message:'private',
                    Data:{TransactionId:'receipt-1', TransactionStatus:'cancelled', Amount:10, PhoneNumber:'01000000000'} }));
            }
            if (req.url.endsWith('/GetBalance')) { reads++; return res.end(JSON.stringify({ Code: 200, Data: { AvailableBalance: 1000 } })); }
            if (req.url.endsWith('/Inquiry')) return res.end(JSON.stringify({ Code: 200, Data: { PaymentBillInfo: 'isolated-bill' } }));
            payments++; res.end(JSON.stringify({ Code: 200, Data: { TransactionId: 'isolated-1', RefNumber: '010****678', Status: 'paid' } }));
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

test('real HTTP reads after six minutes retain the still-valid provider JWT', async () => {
    let now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    mode = 'long-jwt';
    try {
        expect(await api.getApiProviderBalance(config)).toMatchObject({ success: true });
        now += 6 * 60 * 1000;
        expect(await api.getApiProviderBalance(config)).toMatchObject({ success: true });
        expect({ logins, payments, reads }).toEqual({ logins: 1, payments: 0, reads: 2 });
    } finally { clock.mockRestore(); }
});

test.each(['success', 'throttled'])('direct and queued clients share one real HTTP login under %s', async scenario => {
    const keys = ['ZAYN_AGGREGATOR_URL', 'ZAYN_USERNAME', 'ZAYN_PASSWORD'];
    const previous = keys.map(key => process.env[key]);
    process.env.ZAYN_AGGREGATOR_URL = config.apiUrl;
    process.env.ZAYN_USERNAME = config.apiUsername;
    process.env.ZAYN_PASSWORD = config.apiPassword;
    mode = scenario;
    try {
        const direct = require('../services/zaynpayApi');
        const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => i % 2
            ? direct.inquiry('01012345678', 100) : api.getApiProviderBalance(config)));
        if (scenario === 'success') expect(results.every(result => result.status === 'fulfilled')).toBe(true);
        else expect(results.filter(result => result.status === 'rejected')).toHaveLength(25);
        expect(logins).toBe(1);
        expect(payments).toBe(0);
    } finally {
        keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    }
});

test('status lookup identifies authentication throttling without leaking provider diagnostics', async () => {
    mode = 'throttled';
    const result = await api.getApiProviderTransaction(config, 'receipt-1');
    expect(result).toMatchObject({success:false, diagnostics:{
        providerLastCheckStage:'auth', providerLastCheckHttpStatus:429, providerLastCheckProviderCode:null, providerLastCheckRetrySource:'provider_header',
        providerLastCheckRetryAfterSeconds:expect.any(Number),providerLastCheckTransport:null
    }});
    expect(logins).toBe(1);
    expect(payments).toBe(0);
    expect(reads).toBe(0);
});

test.each([
    ['auth-network-reset','auth',null,null,'connection',0],
    ['print-network-reset','print',null,null,'connection',1],
    ['print-business-error','print',200,422,null,1]
])('status lookup reports only safe diagnostics for %s', async (scenario, stage, http, code, transport, readCount) => {
    mode = scenario;
    const result = await api.getApiProviderTransaction(config,'receipt-1');
    expect(result).toMatchObject({success:false, diagnostics:{
        providerLastCheckStage:stage, providerLastCheckHttpStatus:http,
        providerLastCheckProviderCode:code, providerLastCheckTransport:transport
    }});
    expect(result.providerStatus).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private');
    expect({logins,payments,reads}).toEqual({logins:1,payments:0,reads:readCount});
});
