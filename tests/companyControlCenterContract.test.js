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

    test('moves each company administration area to a direct workspace URL', () => {
        expect(routes).toContain("router.get('/company/:id', requireAuth, (req, res)");
        expect(routes).toContain("router.get('/company/:id/:section', requireAuth");
        expect(routes).toContain("res.render('company_workspace'");
        expect(routes).toContain("'overview', 'profile', 'security', 'finance', 'operations', 'api', 'webhooks', 'reports', 'audit'");

        const workspace = fs.readFileSync(path.join(__dirname, '../views/company_workspace.ejs'), 'utf8');
        expect(workspace).toContain('sectionNames');
        expect(workspace).toContain('route = (name)');
        expect(workspace).toContain("section === 'webhooks'");
        expect(workspace).toContain("section === 'audit'");
        expect(workspace).toContain("section === 'api' && !isMaster");
        expect(workspace).toContain("section === 'webhooks' && !isMaster");
    });

    test('keeps the company profile and its manager credentials on a protected route', () => {
        expect(routes).toContain("router.post('/company/:id/profile', requireAuth, requireMaster");
        expect(routes).toContain('verifyCompanyProfileMultipartCsrf');
        expect(routes).toContain('companyLogoUpload.single');
        expect(routes).toContain("action: 'COMPANY_PROFILE_UPDATED'");

        const workspace = fs.readFileSync(path.join(__dirname, '../views/company_workspace.ejs'), 'utf8');
        expect(workspace).toContain('name="companyLogo"');
        expect(workspace).toContain('name="managerUsername"');
        expect(workspace).toContain('name="managerPassword"');
        expect(workspace).toContain('name="notificationPhone"');
        expect(workspace).toContain('name="receiptPhone"');
        expect(workspace).toContain('libyaRegions');
    });
});
