'use strict';

const fs = require('fs');
const path = require('path');

describe('Account integration PDF download contract', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../routes/clients.js'), 'utf8');
    const companyView = fs.readFileSync(path.join(__dirname, '../views/company_details.ejs'), 'utf8');
    const userView = fs.readFileSync(path.join(__dirname, '../views/user_details.ejs'), 'utf8');
    const clientsView = fs.readFileSync(path.join(__dirname, '../views/clients.ejs'), 'utf8');

    test('protects the company and agent PDF endpoints with master access', () => {
        expect(routes).toContain("router.get('/company/:id/integration-guide.pdf', requireAuth, requireMaster");
        expect(routes).toContain("router.get('/user/:id/integration-guide.pdf', requireAuth, requireMaster");
        expect(routes).toContain("router.get('/company/:id/sandbox-api-guide.pdf', requireAuth, requireMaster");
        expect(routes).toContain("router.get('/user/:id/sandbox-api-guide.pdf', requireAuth, requireMaster");
        expect(routes).toContain("res.setHeader('Cache-Control', 'private, no-store, max-age=0')");
        expect(routes).toContain("action: 'MERCHANT_API_DOCUMENT_EXPORTED'");
    });

    test('lets only the master rotate a company API key and immediately revoke the previous one', () => {
        expect(routes).toContain("router.post('/company/:id/rotate-api-token', requireAuth, requireMaster");
        expect(routes).toContain("action: 'MERCHANT_API_KEY_ROTATED'");
        expect(routes).toContain('previousKeyRevokedImmediately: true');
        expect(companyView).toContain('/company/<%= company._id %>/rotate-api-token');
        expect(companyView).toContain('تبديل المفتاح');
    });

    test('shows the button for companies and only for agent accounts in the user profile', () => {
        expect(companyView).toContain('/company/<%= company._id %>/integration-guide.pdf');
        expect(userView).toContain('<% if (isAgentAccount) { %>');
        expect(userView).toContain('/user/<%= user._id %>/integration-guide.pdf');
    });

    test('shows API test document downloads on registered company and agent cards', () => {
        expect(clientsView).toContain('/company/<%= c._id %>/sandbox-api-guide.pdf');
        expect(clientsView).toContain('/user/<%= agent._id %>/sandbox-api-guide.pdf');
        expect(clientsView).toContain('تحميل ملف اختبار API');
    });
});
