'use strict';

const fs = require('fs');
const path = require('path');

describe('Admin report PDF download contract', () => {
    const reportsView = fs.readFileSync(path.join(__dirname, '../views/reports.ejs'), 'utf8');
    const reportsRoute = fs.readFileSync(path.join(__dirname, '../routes/reports.js'), 'utf8');

    test('starts a native browser download instead of a temporary blob link', () => {
        expect(reportsView).toContain('window.location.assign(`/reports/download.pdf?${query.toString()}`)');
        expect(reportsView).not.toContain('response.blob()');
        expect(reportsView).not.toContain('URL.createObjectURL');
    });

    test('serves the generated report as a PDF attachment', () => {
        expect(reportsRoute).toContain("res.setHeader('Content-Type', 'application/pdf')");
        expect(reportsRoute).toContain("res.setHeader('Content-Disposition', `attachment;");
    });
});
