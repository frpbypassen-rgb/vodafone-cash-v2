'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const corporateRouter = require('../routes/corporate');

const REMOVED_PORTAL_PATHS = [
    'views/corporate/dashboard-desktop.ejs',
    'views/corporate/dashboard-mobile.ejs',
    'views/client/company_next.ejs',
    'public/css/corporate-desktop.css',
    'public/css/corporate-mobile.css',
    'public/css/company-next.css',
    'public/js/corporate-desktop.js',
    'public/js/corporate-mobile.js',
    'public/js/corporate-sw.js',
    'routes/corporateApi.js',
    'controllers/corporatePortalController.js',
    'scripts/seedCorporatePortal.js'
];

describe('legacy corporate portal redirects', () => {
    const app = express();
    app.use('/corporate', corporateRouter);
    app.get('/client/company-next', (_req, res) => res.redirect(302, '/client/services'));

    test.each([
        '/corporate',
        '/corporate/',
        '/corporate/transfers',
        '/corporate/approvals',
        '/corporate?view=desktop',
        '/corporate?view=mobile'
    ])('sends %s to /client/services', async (path) => {
        const response = await request(app).get(path);
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('/client/services');
    });

    test('sends /client/company-next to /client/services', async () => {
        const response = await request(app).get('/client/company-next');
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('/client/services');
    });

    test('removes competing corporate and company-next UI files', () => {
        REMOVED_PORTAL_PATHS.forEach((relativePath) => {
            expect(fs.existsSync(path.join(__dirname, '..', relativePath))).toBe(false);
        });
    });
});
