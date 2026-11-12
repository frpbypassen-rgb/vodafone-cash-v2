'use strict';

// Real HTTP/Axios against loopback only: no provider credentials or payments.
jest.mock('../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
const http = require('node:http');
let server;
let client;
let mode;
let authCount;
let paymentCount;
let redirectedCount;
let inquiryCount;
const previousEnv = { ...process.env };
beforeAll(async () => {
    server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('Content-Type', 'application/json');
            if (req.url.endsWith('/GetToken')) {
                authCount++;
                return res.end(JSON.stringify({ Code: '200', Data: { Access_Token: 'isolated-token-' + authCount } }));
            }
            if (req.url.endsWith('/Inquiry')) {
                inquiryCount++;
                if (mode === 'expired' && inquiryCount === 1) {
                    res.statusCode = 401;
                    return res.end('{}');
                }
                return res.end(JSON.stringify({ Code: 200, Data: { PaymentBillInfo: 'synthetic-bill' } }));
            }
            if (req.url.endsWith('/Payment')) {
                paymentCount++;
                if (mode === 'redirect') {
                    res.statusCode = 307;
                    res.setHeader('Location', '/redirected');
                    return res.end('{}');
                }
                if (mode === 'lost') return req.socket.destroy();
                if (mode === 'returned') return res.end(JSON.stringify({ Code: 200, Data: { Status: 'Refunded', RefNumber: '010****123' } }));
                return res.end(JSON.stringify({ Code: 200, Data: { IsPaid: true, RefNumber: '010****123' } }));
            }
            redirectedCount++;
            res.end('{}');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.EXTERNAL_API_ENABLED = 'true';
    process.env.ZAYN_AGGREGATOR_URL = 'http://127.0.0.1:' + server.address().port;
    process.env.ZAYN_USERNAME = 'isolated-user';
    process.env.ZAYN_PASSWORD = 'isolated-password';
    client = require('../services/zaynpayApi');
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const key of ['EXTERNAL_API_ENABLED', 'ZAYN_AGGREGATOR_URL', 'ZAYN_USERNAME', 'ZAYN_PASSWORD']) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
    }
});
beforeEach(() => {
    mode = 'success';
    authCount = paymentCount = redirectedCount = inquiryCount = 0;
    client.token = null;
});
test('real HTTP 401 refreshes Inquiry once then pays once', async () => {
    mode = 'expired';
    const bill = await client.inquiry('01012345678', 100);
    expect((await client.pay(bill, '01012345678', 100)).success).toBe(true);
    expect({ authCount, inquiryCount, paymentCount }).toEqual({ authCount: 2, inquiryCount: 2, paymentCount: 1 });
});
test.each(['redirect', 'lost', 'returned'])('real %s response stays unresolved without an automatic Payment retry', async scenario => {
    mode = scenario;
    const bill = await client.inquiry('01012345678', 100);
    expect(await client.pay(bill, '01012345678', 100)).toMatchObject({ success: false, unresolved: true });
    expect(paymentCount).toBe(1);
    expect(redirectedCount).toBe(0);
});
test('50 concurrent inquiries share one login instead of 50 credential submissions', async () => {
    const bills = await Promise.all(Array.from({ length: 50 }, () => client.inquiry('01012345678', 100)));
    expect(bills).toHaveLength(50);
    expect(authCount).toBe(1);
    expect(inquiryCount).toBe(50);
    expect(paymentCount).toBe(0);
});
