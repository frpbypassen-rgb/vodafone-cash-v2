'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const dashboardPath = path.join(__dirname, '..', 'views', 'executor', 'dashboard.ejs');

describe('Executor cancellation reasons', () => {
    const template = fs.readFileSync(dashboardPath, 'utf8');

    test('renders the predefined cancellation reasons and the other-reason field', () => {
        expect(template).toContain('لا يوجد محفظة');
        expect(template).toContain('محفظة ليميت');
        expect(template).toContain('الخدمة متوقفة حاليا');
        expect(template).toContain('الرقم غير صحيح');
        expect(template).toContain('swal-cancel-other-reason');
    });

    test('compiles the executor dashboard template', () => {
        expect(() => ejs.compile(template, { filename: dashboardPath })).not.toThrow();
    });
});
