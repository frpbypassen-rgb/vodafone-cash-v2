'use strict';

const express = require('express');
const request = require('supertest');
const {
    ACCOUNTANT_PERMISSIONS,
    normalizeAdminRole,
    permissionsForRole,
    accountantPathAllowed,
    adminHrefVisible,
    canSubscribeAdminChannel
} = require('../config/adminRoles');
const { enforceAdminPermissions, enforceAccountantScope } = require('../middlewares/securityControl');

const accountantApp = () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = {
            isLoggedIn: true,
            adminRole: 'accountant',
            adminPermissions: [...ACCOUNTANT_PERMISSIONS, 'accounts.manage', 'settings.manage']
        };
        next();
    });
    app.use(enforceAccountantScope);
    app.use(enforceAdminPermissions);
    app.get('/', (_req, res) => res.json({ ok: true, page: 'dashboard' }));
    app.get('/reports', (_req, res) => res.json({ ok: true, page: 'reports' }));
    app.get('/financial-movements', (_req, res) => res.json({ ok: true, page: 'ledger' }));
    app.get('/clients', (_req, res) => res.json({ ok: true, page: 'clients' }));
    app.get('/executors', (_req, res) => res.json({ ok: true, page: 'executors' }));
    app.get('/executor/:id', (_req, res) => res.json({ ok: true, page: 'executor' }));
    app.get('/company/:id', (_req, res) => res.json({ ok: true, page: 'company' }));
    app.get('/user/:id', (_req, res) => res.json({ ok: true, page: 'agent' }));
    app.get('/transactions/live', (_req, res) => res.json({ ok: true, page: 'live' }));
    app.get('/settings', (_req, res) => res.json({ ok: true, page: 'settings' }));
    app.post('/settings/update', (_req, res) => res.json({ ok: true }));
    app.post('/user/1/add-balance', (_req, res) => res.json({ ok: true }));
    app.post('/executor/1/toggle-status', (_req, res) => res.json({ ok: true }));
    app.post('/executor/1/test-api', (_req, res) => res.json({ ok: true }));
    app.get('/api/dashboard/intelligence', (_req, res) => res.json({ ok: true }));
    app.post('/transaction/1/assign-executor', (_req, res) => res.json({ ok: true }));
    app.post('/logout', (_req, res) => res.json({ ok: true, logout: true }));
    return app;
};

describe('accountant admin read-only role', () => {
    test('forces a fixed read-only permission set and ignores manage checkboxes', () => {
        expect(normalizeAdminRole('accountant')).toBe('accountant');
        expect(permissionsForRole('accountant', ['accounts.manage', 'settings.manage', 'reports.read']))
            .toEqual([...ACCOUNTANT_PERMISSIONS]);
        expect(ACCOUNTANT_PERMISSIONS).toEqual(['accounts.read', 'executors.read']);
        expect(permissionsForRole('admin', ['accounts.manage', 'not-a-permission'])).toEqual(['accounts.manage']);
    });

    test('server blocks mutations even if the session still lists manage permissions', async () => {
        const app = accountantApp();
        const home = await request(app).get('/');
        const reports = await request(app).get('/reports').set('Accept', 'application/json');
        const ledger = await request(app).get('/financial-movements').set('Accept', 'application/json');
        const live = await request(app).get('/transactions/live').set('Accept', 'application/json');
        const clients = await request(app).get('/clients').set('Accept', 'application/json');
        const executors = await request(app).get('/executors').set('Accept', 'application/json');
        const executor = await request(app).get('/executor/1').set('Accept', 'application/json');
        const company = await request(app).get('/company/1').set('Accept', 'application/json');
        const agent = await request(app).get('/user/1').set('Accept', 'application/json');
        const settingsGet = await request(app).get('/settings').set('Accept', 'application/json');
        const settingsPost = await request(app).post('/settings/update').set('Accept', 'application/json');
        const balancePost = await request(app).post('/user/1/add-balance').set('Accept', 'application/json');
        const executorPost = await request(app).post('/executor/1/toggle-status').set('Accept', 'application/json');
        const apiTestPost = await request(app).post('/executor/1/test-api').set('Accept', 'application/json');
        const assignPost = await request(app).post('/transaction/1/assign-executor').set('Accept', 'application/json');
        const dashboardApi = await request(app).get('/api/dashboard/intelligence').set('Accept', 'application/json');
        const logout = await request(app).post('/logout').set('Accept', 'application/json');

        expect(home.status).toBe(302);
        expect(home.headers.location).toBe('/clients');
        expect(reports.status).toBe(403);
        expect(ledger.status).toBe(403);
        expect(live.status).toBe(403);
        expect(clients.status).toBe(200);
        expect(executors.status).toBe(200);
        expect(executor.status).toBe(200);
        expect(company.status).toBe(200);
        expect(agent.status).toBe(200);
        expect(settingsGet.status).toBe(403);
        expect(settingsPost.status).toBe(403);
        expect(balancePost.status).toBe(403);
        expect(executorPost.status).toBe(403);
        expect(apiTestPost.status).toBe(403);
        expect(assignPost.status).toBe(403);
        expect(dashboardApi.status).toBe(403);
        expect(logout.status).toBe(200);
        expect(settingsPost.body.code).toBe('ADMIN_PERMISSION_DENIED');
    });

    test('keeps agency SubAccount privacy out of accountant navigation', () => {
        expect(adminHrefVisible('accountant', '/reports')).toBe(false);
        expect(adminHrefVisible('accountant', '/clients')).toBe(true);
        expect(adminHrefVisible('accountant', '/executors')).toBe(true);
        expect(adminHrefVisible('accountant', '/settings')).toBe(false);
        expect(adminHrefVisible('accountant', '/settings/users')).toBe(false);
        expect(accountantPathAllowed('GET', '/sub-account/1')).toBe(false);
        expect(accountantPathAllowed('POST', '/sub-account/1/delete')).toBe(false);
        expect(accountantPathAllowed('GET', '/admin/accounts/user/1/edit')).toBe(false);
        expect(accountantPathAllowed('GET', '/company/1')).toBe(true);
        expect(accountantPathAllowed('GET', '/user/1')).toBe(true);
        expect(accountantPathAllowed('GET', '/executors')).toBe(true);
        expect(accountantPathAllowed('GET', '/executor/1')).toBe(true);
        expect(accountantPathAllowed('GET', '/executor/1/kenan-history')).toBe(false);
        expect(accountantPathAllowed('POST', '/executor/1/test-api')).toBe(false);
        expect(accountantPathAllowed('GET', '/api/dashboard/intelligence')).toBe(false);
        expect(accountantPathAllowed('GET', '/admin/accountant-enroll')).toBe(true);
        expect(accountantPathAllowed('GET', '/admin/accountant-enroll/options')).toBe(true);
        expect(accountantPathAllowed('POST', '/admin/accountant-enroll/verify')).toBe(true);
        expect(accountantPathAllowed('POST', '/admin/accountant-enroll/options')).toBe(false);
        expect(accountantPathAllowed('GET', '/admin/accountant-enroll/verify')).toBe(false);
    });

    test('old accountant permissions cannot subscribe to operations or support sockets', () => {
        const oldAccountant = { isLoggedIn: true, adminRole: 'accountant', adminPermissions: ['*', 'transactions.read', 'support.read'] };
        expect(canSubscribeAdminChannel(oldAccountant, 'transactions.read')).toBe(false);
        expect(canSubscribeAdminChannel(oldAccountant, 'support.read')).toBe(false);
        expect(canSubscribeAdminChannel({ isLoggedIn: true, adminRole: 'admin', adminPermissions: ['transactions.read'] }, 'transactions.read')).toBe(true);
    });
});
