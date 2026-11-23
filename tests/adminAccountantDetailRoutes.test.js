'use strict';

jest.mock('../services/adminExecutorDetailService', () => ({
    loadExecutorHistory: jest.fn()
}));
jest.mock('../services/adminAccountVisibilityService', () => ({
    adminAccountFindQuery: jest.fn((_req, filter) => filter),
    loadAdminAccountHistory: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const ExecutorGroup = require('../models/ExecutorGroup');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const { loadExecutorHistory } = require('../services/adminExecutorDetailService');
const { loadAdminAccountHistory } = require('../services/adminAccountVisibilityService');
const { enforceAccountantScope } = require('../middlewares/securityControl');
const executorRoutes = require('../routes/executors');
const clientRoutes = require('../routes/clients');

const createApp = () => {
    const app = express();
    app.use((req, res, next) => {
        req.session = { isLoggedIn: true, adminRole: 'accountant', adminName: 'محاسب تجريبي' };
        res.render = (view, data) => res.json({ view, name: data.bot?.name || data.account?.name, count: data.history?.rows?.length ?? data.transactions?.length });
        next();
    });
    app.use(enforceAccountantScope);
    app.use(executorRoutes);
    app.use(clientRoutes);
    return app;
};

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
});

test('accountant reads an API executor without saving it or contacting its provider', async () => {
    const save = jest.fn();
    const bot = { _id: 'bot-1', name: 'بوت تجريبي', isApiBot: true, status: 'active', save };
    const select = jest.fn().mockResolvedValue(bot);
    const findOne = jest.spyOn(ExecutorGroup, 'findOne').mockReturnValue({ select });
    loadExecutorHistory.mockResolvedValue({ rows: [], page: 1, totalPages: 1 });

    const response = await request(createApp()).get('/executor/bot-1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ view: 'accountant_executor_detail', name: 'بوت تجريبي', count: 0 });
    expect(loadExecutorHistory).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ _id: 'bot-1' }));
    expect(select.mock.calls[0][0]).not.toContain('apiToken');
    expect(loadExecutorHistory.mock.calls[0][2].tab).toBe('operations');
    expect(save).not.toHaveBeenCalled();
});

test('accountant account details use the read-only view and scoped history', async () => {
    const account = { _id: 'account-1', name: 'شركة تجريبية', balance: 20 };
    jest.spyOn(ClientCompany, 'findOne').mockResolvedValue(account);
    loadAdminAccountHistory.mockResolvedValue({ transactions: [{ customId: 'test-1' }] });

    const response = await request(createApp()).get('/company/account-1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ view: 'accountant_account_detail', name: 'شركة تجريبية', count: 1 });
    expect(loadAdminAccountHistory).toHaveBeenCalledTimes(1);
    expect(loadAdminAccountHistory.mock.calls[0][1]).toEqual(expect.objectContaining({ account, kind: 'company', limit: 50 }));
});

test('accountant cannot call a direct mutation route even if the router contains it', async () => {
    const find = jest.spyOn(User, 'findOne');
    const response = await request(createApp()).post('/user/account-1/add-balance').set('Accept', 'application/json').send({ amount: 100 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ADMIN_PERMISSION_DENIED');
    expect(find).not.toHaveBeenCalled();
});
