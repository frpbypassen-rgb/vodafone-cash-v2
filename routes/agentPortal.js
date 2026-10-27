'use strict';

const express = require('express');
const rateLimit = require('../utils/requestRateLimit');
const requireAgentPortal = require('../middlewares/requireAgentPortal');
const requireOperationPin = require('../middlewares/requireOperationPin');
const upload = require('../middlewares/clientDocumentUpload');
const { renderPage } = require('../controllers/agent/workspaceController');
const staff = require('../controllers/agent/staffController');
const registration = require('../controllers/agent/registrationController');
const customers = require('../controllers/portalWorkspace/customersController');
const balances = require('../controllers/portalWorkspace/customerBalancesController');
const settings = require('../controllers/portalWorkspace/settingsController');
const queries = require('../controllers/portalWorkspace/queriesController');
const reports = require('../controllers/portalWorkspace/reportsController');
const transactions = require('../controllers/clientTransactionController');
const dashboard = require('../controllers/clientDashboardController');
const auth = require('../controllers/clientAuthController');

const router = express.Router();
router.get('/login', (_req, res) => res.redirect('/login?portal=client'));
router.use(requireAgentPortal);
router.use(require('./agentReportEmail'));
router.use(require('./agentTelegram'));
router.get('/', (_req, res) => res.redirect('/agent-portal/dashboard'));
const pages = {
    '/dashboard': 'overview',
    '/services': 'services',
    '/services/:serviceKey': 'service_workbench',
    '/smart-transfer': 'smart_transfer',
    '/internal-transfer': 'internal_transfer',
    '/transactions': 'transactions',
    '/reports': 'reports',
    '/finance': 'finance',
    '/finance/profits': 'agency_profits',
    '/customers': 'customers',
    '/customers/:id': 'customer_profile',
    '/staff': 'staff',
    '/settings': 'settings',
    '/settings/workspace': 'settings',
    '/security': 'security',
    '/support': 'support',
};
for (const [url, page] of Object.entries(pages)) router.get(url, renderPage(page));
router.get('/account', (_req, res) => res.redirect('/agent-portal/finance'));
router.get('/finance/position', (_req, res) => res.redirect('/agent-portal/finance'));
router.get('/finance/agency-account', (_req, res) => res.redirect('/agent-portal/finance'));
router.get(['/finance/customer-balances', '/finance/customer-debts'], (_req, res) => res.redirect('/agent-portal/customers'));
router.get('/transfers', (_req, res) => res.redirect('/agent-portal/transactions'));
router.get('/logout', auth.logout);
router.get('/profile-photo', dashboard.getProfilePhoto);
router.get('/api/transactions', dashboard.getApiTransactions);
router.get('/api/rates', queries.getCurrentRates);
router.get('/transactions/:id/details', queries.getTransactionDetails);
router.get('/reports/export.csv', reports.exportReportCsv);
router.get('/reports/central.pdf', rateLimit({windowMs:60000,max:10,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>String(req.session.clientId)}), reports.downloadCentralAgentReportPdf);
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], transactions.getProxyImage);
router.post('/api/smart-transfer/parse', queries.parseSmartTransferMessage);
router.post(
    '/api/assistant/query',
    rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false }),
    queries.askBusinessAssistant
);
router.post('/transfer', upload.single('idCardImage'), requireOperationPin, transactions.postTransfer);
router.post('/balance-transfer/lookup', transactions.lookupBalanceTransferTarget);
router.post('/balance-transfer', requireOperationPin, transactions.postBalanceTransfer);
router.post('/complaint', transactions.postComplaint);
router.post('/customers/add', customers.postCreateCustomer);
router.post('/customers/:id/toggle', customers.postToggleCustomer);
router.post('/customers/:id/pricing', customers.postUpdateCustomerPricing);
router.post('/customers/:id/balance', balances.postAdjustCustomerBalance);
router.post('/customers/:id/credit-limit', balances.postUpdateCustomerCreditLimit);
router.post('/settings/profile', settings.postUpdateSettings);
router.post('/settings/password', settings.postChangePassword);
router.post('/settings/theme', settings.postClientTheme);
router.post('/agent/staff/add', staff.postAddStaff);
router.post('/agent/staff/:id/toggle', staff.postToggleStaff);
router.post('/agent/staff/:id/password', staff.postResetStaffPassword);
router.post('/agent/staff/:id/permissions', staff.postUpdatePermissions);
router.post('/agent/registration-requests/:id/approve', registration.postApproveClientRequest);
router.post('/agent/registration-requests/:id/reject', registration.postRejectClientRequest);
router.use(require('./portalSharedApi'));
router.use((_req, res) => res.status(404).json({ success: false, code: 'AGENT_ROUTE_NOT_FOUND' }));

module.exports = router;
