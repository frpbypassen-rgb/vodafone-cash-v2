'use strict';

const fs = require('fs');
const path = require('path');
const { ALIASES } = require('../routes/adminAliases');

describe('admin URL aliases for broken /admin/* links', () => {
    test('maps the reported wrong admin URLs onto the real staff routes', () => {
        expect(ALIASES['/admin/settings']).toBe('/settings');
        expect(ALIASES['/admin/users']).toBe('/settings/users');
        expect(ALIASES['/admin/live']).toBe('/transactions/live');
        expect(ALIASES['/admin/transactions']).toBe('/transactions');
        expect(ALIASES['/admin/reports']).toBe('/reports');
        expect(ALIASES['/admin/dashboard']).toBe('/');
        expect(ALIASES['/admin/clients']).toBe('/clients');
        expect(ALIASES['/admin/companies']).toBe('/clients?section=companies');
        expect(ALIASES['/admin/agents']).toBe('/clients?section=agents');
    });

    test('redirects /admin/company/:id and /admin/user/:id onto the real account detail routes', async () => {
        const express = require('express');
        const request = require('supertest');
        const aliases = require('../routes/adminAliases');
        const app = express();
        app.use((req, _res, next) => {
            req.session = { isLoggedIn: true };
            next();
        });
        app.use(aliases);

        const company = await request(app).get('/admin/company/cccccccccccccccccccccccc');
        const agent = await request(app).get('/admin/user/dddddddddddddddddddddddd?section=agents');
        const clients = await request(app).get('/admin/clients?section=companies');

        expect(company.status).toBe(302);
        expect(company.headers.location).toBe('/company/cccccccccccccccccccccccc');
        expect(agent.status).toBe(302);
        expect(agent.headers.location).toBe('/user/dddddddddddddddddddddddd?section=agents');
        expect(clients.status).toBe(302);
        expect(clients.headers.location).toBe('/clients?section=companies');
    });

    test('registers aliases after auth and keeps live operations before parameterized transaction routes', () => {
        const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        expect(appSource).toContain("require('./routes/adminAliases')");
        expect(appSource.indexOf("require('./routes/auth')"))
            .toBeLessThan(appSource.indexOf("require('./routes/adminAliases')"));
        expect(appSource.indexOf("require('./routes/liveOperations')"))
            .toBeLessThan(appSource.indexOf("require('./routes/adminTransactions')"));
        expect(appSource).toMatch(/app\.use\('\/settings'/);
    });
});
