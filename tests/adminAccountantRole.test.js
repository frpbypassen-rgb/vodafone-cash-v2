'use strict';

const express = require('express');
const request = require('supertest');
const {
    ACCOUNTANT_PERMISSIONS,
    normalizeAdminRole,
    permissionsForRole,
    accountantPathAllowed,
    adminHrefVisible
} = require('../config/adminRoles');
const { enforceAdminPermissions } = require('../middlewares/securityControl');

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
    app.use(enforceAdminPermissions);
    app.get('/reports', (_req, res) => res.json({ ok: true, page: 'reports' }));
    app.get('/financial-movements', (_req, res) => res.json({ ok: true, page: 'ledger' }));
    app.get('/clients', (_req, res) => res.json({ ok: true, page: 'clients' }));
    app.get('/transactions/live', (_req, res) => res.json({ ok: true, page: 'live' }));
    app.get('/settings', (_req, res) => res.json({ ok: true, page: 'settings' }));
    app.post('/settings/update', (_req, res) => res.json({ ok: true }));
    app.post('/user/1/add-balance', (_req, res) => res.json({ ok: true }));
    app.post('/transaction/1/assign-executor', (_req, res) => res.json({ ok: true }));
    app.post('/logout', (_req, res) => res.json({ ok: true, logout: true }));
    return app;
};

describe('accountant admin read-only role', () => {
    test('forces a fixed read-only permission set and ignores manage checkboxes', () => {
        expect(normalizeAdminRole('accountant')).toBe('accountant');
        expect(permissionsForRole('accountant', ['accounts.manage', 'settings.manage', 'reports.read']))
            .toEqual([...ACCOUNTANT_PERMISSIONS]);
        expect(permissionsForRole('admin', ['accounts.manage', 'not-a-permission'])).toEqual(['accounts.manage']);
    });

    test('server blocks mutations even if the session still lists manage permissions', async () => {
        const app = accountantApp();
        const reports = await request(app).get('/reports').set('Accept', 'application/json');
        const ledger = await request(app).get('/financial-movements').set('Accept', 'application/json');
        const live = await request(app).get('/transactions/live').set('Accept', 'application/json');
        const clients = await request(app).get('/clients').set('Accept', 'application/json');
        const settingsGet = await request(app).get('/settings').set('Accept', 'application/json');
        const settingsPost = await request(app).post('/settings/update').set('Accept', 'application/json');
        const balancePost = await request(app).post('/user/1/add-balance').set('Accept', 'application/json');
        const assignPost = await request(app).post('/transaction/1/assign-executor').set('Accept', 'application/json');
        const logout = await request(app).post('/logout').set('Accept', 'application/json');

        expect(reports.status).toBe(200);
        expect(ledger.status).toBe(200);
        expect(live.status).toBe(200);
        expect(clients.status).toBe(200);
        expect(settingsGet.status).toBe(403);
        expect(settingsPost.status).toBe(403);
        expect(balancePost.status).toBe(403);
        expect(assignPost.status).toBe(403);
        expect(logout.status).toBe(200);
        expect(settingsPost.body.code).toBe('ADMIN_PERMISSION_DENIED');
    });

    test('keeps agency SubAccount privacy out of accountant navigation', () => {
        expect(adminHrefVisible('accountant', '/reports')).toBe(true);
        expect(adminHrefVisible('accountant', '/clients')).toBe(true);
        expect(adminHrefVisible('accountant', '/settings')).toBe(false);
        expect(adminHrefVisible('accountant', '/settings/users')).toBe(false);
        expect(accountantPathAllowed('GET', '/sub-account/1')).toBe(false);
        expect(accountantPathAllowed('POST', '/sub-account/1/delete')).toBe(false);
        expect(accountantPathAllowed('GET', '/admin/accounts/user/1/edit')).toBe(false);
    });
});
