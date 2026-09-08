'use strict';

const fs = require('fs');
const path = require('path');

describe('Company control center contract', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../routes/clients.js'), 'utf8');
    const view = fs.readFileSync(path.join(__dirname, '../views/company_details.ejs'), 'utf8');

    test('loads the operational data needed by the company control center', () => {
        expect(routes).toContain("const AuditLog = require('../models/AuditLog')");
        expect(routes).toContain("ClientEmployee.find({ companyId: company._id");
        expect(routes).toContain("Ledger.find({ entityId: company._id, entityModel: 'ClientCompany' })");
        expect(routes).toContain('transactionMetrics: metricRows[0] || {}');
        expect(routes).toContain('apiMetrics: apiMetricRows[0] || {}');
    });

    test('exposes separate navigation targets for every company administration area', () => {
        [
            'company-overview',
            'company-profile',
            'company-security',
            'company-finance',
            'company-operations',
            'company-api-integration',
            'company-webhook-integration',
            'company-reports',
            'company-audit'
        ].forEach((sectionId) => expect(view).toContain(sectionId));
        expect(view).toContain('مركز التحكم الموحد');
        expect(view).toContain('الأمان والصلاحيات');
        expect(view).toContain('التقارير والتحليلات');
        expect(view).toContain('سجل التدقيق');
    });
});
