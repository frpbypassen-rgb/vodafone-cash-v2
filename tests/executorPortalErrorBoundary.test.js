'use strict';

jest.mock('../services/executorAuthCache', () => ({
    loadExecutorEmployee: jest.fn(), invalidateExecutorAuth: jest.fn()
}));
jest.mock('../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../services/executorWebPushService', () => ({
    getExecutorWebPushStatus: jest.fn(), upsertExecutorSubscription: jest.fn(),
    disableExecutorSubscription: jest.fn(), sendExecutorWebPushTest: jest.fn()
}));
jest.mock('../services/executorSupportService', () => {
    const actual = jest.requireActual('../services/executorSupportService');
    return {
        ...actual,
        listExecutorTickets: jest.fn(),
        getExecutorGroupChat: jest.fn(),
        replyToExecutorGroupChat: jest.fn(),
        createExecutorTicket: jest.fn(),
        getExecutorDiagnostics: jest.fn(),
        getExecutorTicket: jest.fn(),
        replyToExecutorTicket: jest.fn()
    };
});

const express = require('express');
const request = require('supertest');
const logger = require('../utils/logger');
const { loadExecutorEmployee, invalidateExecutorAuth } = require('../services/executorAuthCache');
const support = require('../services/executorSupportService');
const webPush = require('../services/executorWebPushService');
const portal = require('../routes/executorPortal');

describe('Executor portal error and authorization boundaries', () => {
    let app;
    let employee;

    beforeEach(() => {
        jest.clearAllMocks();
        employee = {
            _id: 'employee-1', status: 'active', role: 'operator', sessionVersion: 3,
            groupId: { _id: 'group-1', status: 'active' }
        };
        loadExecutorEmployee.mockResolvedValue(employee);
        app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.session = { isExecutorLoggedIn: true, executorId: 'employee-1', executorSessionVersion: 3 };
            next();
        });
        app.use('/executor-portal', portal);
    });

    test.each([
        ['get', '/api/support/tickets', 'listExecutorTickets'],
        ['get', '/api/support/group-chat', 'getExecutorGroupChat'],
        ['post', '/api/support/group-chat/replies', 'replyToExecutorGroupChat'],
        ['post', '/api/support/tickets', 'createExecutorTicket'],
        ['get', '/api/support/diagnostics', 'getExecutorDiagnostics'],
        ['get', '/api/support/tickets/ticket-1', 'getExecutorTicket'],
        ['post', '/api/support/tickets/ticket-1/replies', 'replyToExecutorTicket']
    ])('%s %s conceals unexpected failures', async (method, url, operation) => {
        support[operation].mockRejectedValueOnce(new Error('mongodb://user:secret@internal-host'));
        const response = await request(app)[method](`/executor-portal${url}`).send({});
        expect(response.status).toBe(500);
        expect(response.body.success).toBe(false);
        expect(JSON.stringify(response.body)).not.toContain('secret');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    test('preserves a safe validation error and its status', async () => {
        support.createExecutorTicket.mockRejectedValueOnce(new support.ExecutorSupportError('VALIDATION_ERROR', 'عنوان الطلب غير صالح.', 400));
        const response = await request(app).post('/executor-portal/api/support/tickets').send({});
        expect(response.status).toBe(400);
        expect(response.body).toEqual({ success: false, error: 'عنوان الطلب غير صالح.' });
        expect(logger.error).not.toHaveBeenCalled();
    });

    test.each([
        ['get', 'status', 'getExecutorWebPushStatus'],
        ['post', 'subscribe', 'upsertExecutorSubscription'],
        ['post', 'unsubscribe', 'disableExecutorSubscription']
    ])('conceals unexpected web-push %s %s failures', async (method, route, operation) => {
        webPush[operation].mockRejectedValueOnce(new Error('mongodb://user:secret@internal-host'));
        const response = await request(app)[method](`/executor-portal/api/web-push/${route}`).send({});
        expect(response.status).toBe(500);
        expect(response.body.success).toBe(false);
        expect(JSON.stringify(response.body)).not.toContain('secret');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test.each([
        ['INVALID_WEB_PUSH_SUBSCRIPTION', 400], ['WEB_PUSH_SUBSCRIPTION_LIMIT', 409]
    ])('returns a safe web-push validation status for %s', async (code, status) => {
        webPush.upsertExecutorSubscription.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
        const response = await request(app).post('/executor-portal/api/web-push/subscribe').send({});
        expect(response.status).toBe(status);
        expect(response.body.success).toBe(false);
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('bounds test notifications by account before calling the push service', async () => {
        webPush.sendExecutorWebPushTest.mockResolvedValue({ attempted: 1, sent: 1 });
        for (let attempt = 0; attempt < 12; attempt++) {
            const response = await request(app).post('/executor-portal/api/web-push/test').send({});
            expect(response.status).toBe(200);
        }
        const denied = await request(app).post('/executor-portal/api/web-push/test').send({});
        expect(denied.status).toBe(429);
        expect(webPush.sendExecutorWebPushTest).toHaveBeenCalledTimes(12);
    });

    test.each(['suspended', 'revoked', 'inactive-group'])(
        'blocks a %s account before any operation', async (state) => {
            if (state === 'suspended') employee.status = 'suspended';
            if (state === 'revoked') employee.sessionVersion = 4;
            if (state === 'inactive-group') employee.groupId.status = 'suspended';
            const response = await request(app).get('/executor-portal/api/support/tickets');
            expect(response.status).toBe(401);
            expect(response.body.error).toBe('انتهت جلسة الدخول.');
            expect(support.listExecutorTickets).not.toHaveBeenCalled();
            expect(invalidateExecutorAuth).toHaveBeenCalledWith('employee-1');
        }
    );

    test('uses a fresh authorization check for reads as well as writes', async () => {
        support.listExecutorTickets.mockResolvedValueOnce({ tickets: [] });
        await request(app).get('/executor-portal/api/support/tickets');
        expect(loadExecutorEmployee).toHaveBeenCalledWith('employee-1', { fresh: true, lean: true });
    });

    test('an operator cannot enter a manager-only mutation', async () => {
        const response = await request(app).post('/executor-portal/api/employees/create').send({});
        expect(response.status).toBe(403);
        expect(response.body.error).toBe('هذه الصفحة متاحة لمدير المنفذ فقط.');
    });

    test('an accountant cannot execute a financial task', async () => {
        employee.role = 'accountant';
        const response = await request(app).post('/executor-portal/api/complete-task/tx-1').send({});
        expect(response.status).toBe(403);
        expect(response.body.error).toBe('هذا الحساب لا يملك صلاحية تنفيذ العمليات.');
        expect(loadExecutorEmployee).toHaveBeenCalledWith('employee-1', { fresh: true, lean: false });
    });
});
