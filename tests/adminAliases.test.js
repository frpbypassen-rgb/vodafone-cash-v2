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
