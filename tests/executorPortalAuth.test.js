'use strict';
jest.mock('../services/executorAuthCache', () => ({ loadExecutorEmployee: jest.fn(), invalidateExecutorAuth: jest.fn() }));
jest.mock('../services/executorTransactionError', () => ({ logExecutorFailure: jest.fn() }));
const express = require('express');
const request = require('supertest');
const { loadExecutorEmployee, invalidateExecutorAuth } = require('../services/executorAuthCache');
const { requireExecutorAuth, requireExecutorManager, requireExecutorTaskAccess } = require('../middlewares/requireExecutorPortalAuth');
let app, session, employee, handler;
beforeEach(() => {
    jest.clearAllMocks();
    session = { isExecutorLoggedIn: true, executorId: 'executor-1', executorGroupId: 'group-1', executorSessionVersion: 2 };
    employee = { _id: 'executor-1', role: 'manager', status: 'active', sessionVersion: 2, groupId: { _id: 'group-1', status: 'active' } };
    loadExecutorEmployee.mockResolvedValue(employee);
    handler = jest.fn((req, res) => res.json({ success: true, manager: Boolean(req.managerEmp) }));
    app = express();
    app.use((req, res, next) => { req.session = session; next(); });
    app.get('/dashboard', requireExecutorAuth, handler);
    app.get('/api/live-tasks', requireExecutorAuth, requireExecutorTaskAccess, handler);
    app.post('/api/employees/create', requireExecutorManager, handler);
    app.post('/reports/filter', requireExecutorAuth, handler);
    app.get('/reports/employees', requireExecutorAuth, handler);
});
test.each([['post', '/api/employees/create'], ['post', '/reports/filter'], ['get', '/reports/employees'], ['get', '/api/live-tasks']])(
    'blocks incomplete MFA on %s %s before querying or performing any action', async (method, url) => {
        session.mfaEnrollmentRequired = true;
        const response = await request(app)[method](url);
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({ success: false, code: 'MFA_ENROLLMENT_REQUIRED' });
        expect(handler).not.toHaveBeenCalled();
        expect(loadExecutorEmployee).not.toHaveBeenCalled();
    }
);
test('HTML navigation keeps the enrollment redirect', async () => {
    session.mfaEnrollmentRequired = true;
    await request(app).get('/dashboard').expect(302).expect('Location', '/security/mfa-enroll');
});
test.each(['inactive employee', 'inactive group', 'revoked session'])(
    'clears invalid manager session for %s without entering a mutation', async reason => {
        if (reason === 'inactive employee') employee.status = 'paused';
        if (reason === 'inactive group') employee.groupId.status = 'paused';
        if (reason === 'revoked session') employee.sessionVersion = 3;
        await request(app).post('/api/employees/create').expect(401);
        expect(session.isExecutorLoggedIn).toBeUndefined();
        expect(session.executorId).toBeUndefined();
        expect(invalidateExecutorAuth).toHaveBeenCalledWith('executor-1');
        expect(handler).not.toHaveBeenCalled();
    }
);
test('manager auth performs one fresh lookup and attaches the same employee to both contexts', async () => {
    const response = await request(app).post('/api/employees/create');
    expect(response.status).toBe(200);
    expect(response.body.manager).toBe(true);
    expect(loadExecutorEmployee).toHaveBeenCalledTimes(1);
    expect(loadExecutorEmployee).toHaveBeenCalledWith('executor-1', { fresh: true, lean: false });
});
test.each(['accountant', 'unknown'])('refuses task execution for role %s', async role => {
    employee.role = role;
    await request(app).get('/api/live-tasks').expect(403);
    expect(handler).not.toHaveBeenCalled();
});
test('missing report sessions receive JSON rather than a successful HTML login page', async () => {
    session = {};
    const response = await request(app).get('/reports/employees');
    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
});
