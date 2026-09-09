'use strict';

const fs = require('fs');
const path = require('path');
const { money } = require('../services/pointOfSaleSettlementService');

describe('point of sale external settlement contract', () => {
    test('keeps three-decimal LYD accounting precision', () => {
        expect(money(12.3456)).toBe(12.346);
    });

    test('exposes a two-step reserve then confirm workflow', () => {
        const service = fs.readFileSync(path.join(__dirname, '../services/pointOfSaleSettlementService.js'), 'utf8');
        expect(service).toContain("settlement.status !== 'awaiting_external_confirmation'");
        expect(service).toContain("event: 'reserved'");
        expect(service).toContain("event: 'external_confirmation_received'");
        expect(service).toContain("entityModel: 'PointOfSaleCustomer'");
    });

    test('keeps POS integration outside browser CSRF and mounts its API namespace', () => {
        const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
        const csrf = fs.readFileSync(path.join(__dirname, '../middlewares/csrfProtection.js'), 'utf8');
        const route = fs.readFileSync(path.join(__dirname, '../routes/pointOfSaleApi.js'), 'utf8');
        expect(app).toContain("app.use('/api/v1/pos', require('./routes/pointOfSaleApi'))");
        expect(csrf).toContain("'/api/v1/pos'");
        expect(route).toContain("router.post('/customers/:customerId/settlements'");
        expect(route).toContain("router.post('/settlements/:reference/confirm'");
        expect(route).toContain("router.post('/settlements/:reference/cancel'");
    });
});
