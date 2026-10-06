'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { readPortalView } = require('./helpers/executorPortalSources');

const dashboardPath = path.join(__dirname, '..', 'views', 'executor', 'dashboard.ejs');

describe('Executor cancellation reasons', () => {
    const template = fs.readFileSync(dashboardPath, 'utf8');

    test('renders the predefined cancellation reasons and the other-reason field', () => {
        const source = readPortalView('dashboard');
        expect(source).toContain('لا يوجد محفظة');
        expect(source).toContain('محفظة ليميت');
        expect(source).toContain('الخدمة متوقفة حاليا');
        expect(source).toContain('الرقم غير صحيح');
        expect(source).toContain('swal-cancel-other-reason');
    });

    test('compiles the executor dashboard template', () => {
        expect(() => ejs.compile(template, { filename: dashboardPath })).not.toThrow();
    });
});
