'use strict';

jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../services/clientHubContextService', () => ({ loadWalletHubAccount: jest.fn() }));
jest.mock('../services/clientDepositRequestService', () => ({
    listClientDepositRequests: jest.fn(),
    createClientDepositRequest: jest.fn()
}));
jest.mock('../services/supportRealtimeService', () => ({ emitSupportTicketUpdate: jest.fn() }));

const express = require('express');
const request = require('supertest');
const User = require('../models/User');
const depositService = require('../services/clientDepositRequestService');
const { emitSupportTicketUpdate } = require('../services/supportRealtimeService');
const controller = require('../controllers/clientDepositController');

const secret = 'mongodb://private-user:private-password@internal-db/private-db';
const cases = [
    ['get', 'listClientDepositRequests', 'تعذر تحميل طلبات الإيداع.'],
    ['post', 'createClientDepositRequest', 'تعذر إرسال طلب الإيداع.']
];
let app;

beforeEach(() => {
    jest.resetAllMocks();
    User.findById.mockResolvedValue({ _id: 'client-test', status: 'active', role: 'client', balance: 75 });
    depositService.listClientDepositRequests.mockResolvedValue([]);
    depositService.createClientDepositRequest.mockResolvedValue({ customId: 'CLDEP-TEST' });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { accountType: 'user', clientId: 'client-test' };
        next();
    });
    app.get('/deposits', controller.getDepositRequests);
    app.post('/deposits', controller.postDepositRequest);
});

describe.each(cases)('%s deposit error privacy', (method, serviceMethod, fallback) => {
    test('database lookup failures never expose internal details', async () => {
        User.findById.mockRejectedValueOnce(new Error(secret));
        const response = await request(app)[method]('/deposits').send({ amount: 20, note: 'bank reference' });
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ success: false, error: fallback });
        expect(response.text).not.toContain(secret);
        expect(depositService[serviceMethod]).not.toHaveBeenCalled();
    });

    test.each([undefined, 500, 503])('internal service failure with status %s has a generic response', async (status) => {
        depositService[serviceMethod].mockRejectedValueOnce(Object.assign(new Error(secret), { status }));
        const response = await request(app)[method]('/deposits').send({ amount: 20, note: 'bank reference' });
        expect(response.status).toBe(status || 500);
        expect(response.body).toEqual({ success: false, error: fallback });
        expect(response.text).not.toContain(secret);
    });

    test('explicit validation errors retain their useful client message', async () => {
        depositService[serviceMethod].mockRejectedValueOnce(Object.assign(new Error('قيمة الإيداع غير صالحة.'), { status: 422 }));
        const response = await request(app)[method]('/deposits').send({ amount: -1 });
        expect(response.status).toBe(422);
        expect(response.body).toEqual({ success: false, error: 'قيمة الإيداع غير صالحة.' });
    });

    test('an invalid error status cannot produce success or disclose details', async () => {
        depositService[serviceMethod].mockRejectedValueOnce(Object.assign(new Error(secret), { status: 200 }));
        const response = await request(app)[method]('/deposits').send({ amount: 20 });
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ success: false, error: fallback });
    });
});

test('realtime failure after creating a request is private and never repeats creation', async () => {
    emitSupportTicketUpdate.mockImplementationOnce(() => { throw new Error(secret); });
    const response = await request(app).post('/deposits').send({ amount: 20, note: 'bank reference' });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, error: 'تعذر إرسال طلب الإيداع.' });
    expect(depositService.createClientDepositRequest).toHaveBeenCalledTimes(1);
});

test('successful list and submission retain their response contracts', async () => {
    const listed = await request(app).get('/deposits');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ success: true, requests: [], balance: 75 });
    const submitted = await request(app).post('/deposits').send({ amount: 20, note: 'bank reference' });
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({ success: true, request: { customId: 'CLDEP-TEST' } });
    expect(emitSupportTicketUpdate).toHaveBeenCalledTimes(1);
});
