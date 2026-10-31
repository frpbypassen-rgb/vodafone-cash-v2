// routes/clientPortal.js
const express = require('express');
const path = require('path');
const router = express.Router();

const { isWalletHubSession, canRequestRetailDeposit } = require('../utils/walletHubHelper');




const rateLimit = require('../utils/requestRateLimit');

const requireOperationPin = require('../middlewares/requireOperationPin');

const otpVerifyLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 8,
    message: 'تم تجاوز عدد محاولات رمز التحقق. سجل الدخول من جديد بعد خمس دقائق.',
    standardHeaders: true,
    legacyHeaders: false
});

const businessAssistantLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, error: 'تم تجاوز عدد أسئلة المساعد مؤقتاً. حاول بعد دقيقة.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Middleware
const { requireClientAuth, endUnauthorizedClientSession } = require('../middlewares/clientPortalAuth');

const { getSupportIdentity } = require('../services/portalSupportService');
router.use(require('./portalSharedApi'));
router.use(require('./customerNotifications'));
router.use(require('./customerAccountDocuments'));
router.use(require('./retailOperationDetails'));
router.use(require('./companyReportEmail'));
router.use(require('./companyTelegram'));

// Controllers
const clientAuthController = require('../controllers/clientAuthController');
const clientDashboardController = require('../controllers/clientDashboardController');
const clientTransactionController = require('../controllers/clientTransactionController');
const clientCompanyController = require('../controllers/clientCompanyController');
const clientAgentController = require('../controllers/clientAgentController');
const clientWorkspaceController = require('../controllers/clientWorkspaceController');
const clientHubController = require('../controllers/clientHubController');
const retailTransferController = require('../controllers/retailTransferController');
const clientDepositController = require('../controllers/clientDepositController');
const businessPortalService = require('../services/businessPortalService');

const clientDocumentUpload = require('../middlewares/clientDocumentUpload');

router.get('/', (req, res) => {
    if (req.session.isClientLoggedIn && req.session.clientId) {
        return res.redirect(businessPortalService.resolveClientPostLoginHref(req.session.accountType));
    }
    return res.redirect('/login?portal=client');
});

// ===============================================
// 👤 Auth Routes
// ===============================================
router.get('/login', (req, res) => {
    if (req.session.isClientLoggedIn && req.session.clientId) {
        return res.redirect(businessPortalService.resolveClientPostLoginHref(req.session.accountType));
    }
    return res.redirect('/login?portal=client');
});
router.post('/login', (req, res) => res.redirect(307, '/login?portal=client'));
router.get('/register', clientAuthController.getRegister);
router.get('/register/agent-lookup', clientAuthController.lookupAgent);
router.post('/register', clientAuthController.postRegister);
router.get('/verify', clientAuthController.getVerify);
router.use('/verify', require('./businessLoginChoice'));
router.post('/verify', otpVerifyLimiter, clientAuthController.postVerify);
router.get('/logout', clientAuthController.logout);
router.get('/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/client/');
    return res.sendFile(path.join(__dirname, '../public/company-portal-sw.js'));
});

// ===============================================
// 📊 Dashboard Routes
// ===============================================
router.get('/dashboard', requireClientAuth, clientDashboardController.getDashboard);
router.get('/company-next', (_req, res) => res.redirect(302, '/client/services'));
router.get('/account', requireClientAuth, clientHubController.getAccount);
router.get('/transfers', requireClientAuth, clientHubController.getTransfers);
router.get('/deposits', requireClientAuth, clientDepositController.getDepositsPage);
router.get('/api/deposits', requireClientAuth, clientDepositController.getDepositRequests);
router.post('/api/deposits', requireClientAuth, clientDepositController.postDepositRequest);
router.get('/profile-photo', requireClientAuth, clientDashboardController.getProfilePhoto);
router.post('/profile', requireClientAuth, clientDashboardController.postUpdateOwnProfile);
router.get('/api/transactions', requireClientAuth, clientDashboardController.getApiTransactions);
router.get('/api/rates', requireClientAuth, clientWorkspaceController.getCurrentRates);
router.get('/services', requireClientAuth, clientHubController.getServices);
router.get('/services/:serviceKey', requireClientAuth, retailTransferController.renderPage('service_workbench'));
router.get('/smart-transfer', requireClientAuth, retailTransferController.renderPage('smart_transfer'));
router.get('/internal-transfer', requireClientAuth, retailTransferController.renderPage('internal_transfer'));
router.get('/company/deposits', requireClientAuth, clientWorkspaceController.renderPage('deposits'));
router.get('/transactions', requireClientAuth, clientWorkspaceController.renderPage('transactions'));
router.get('/finance', requireClientAuth, clientWorkspaceController.renderPage('finance'));
router.get('/finance/customer-balances', requireClientAuth, clientWorkspaceController.renderPage('agency_balances'));
router.get('/finance/customer-debts', requireClientAuth, clientWorkspaceController.renderPage('agency_debts'));
router.get('/finance/agency-account', requireClientAuth, clientWorkspaceController.renderPage('agency_account'));
router.get('/finance/position', requireClientAuth, clientWorkspaceController.renderPage('agency_position'));
router.get('/finance/profits', requireClientAuth, clientWorkspaceController.renderPage('agency_profits'));
router.get('/customers', requireClientAuth, clientWorkspaceController.renderPage('customers'));
router.get('/customers/:id', requireClientAuth, clientWorkspaceController.renderPage('customer_profile'));
router.get('/staff', requireClientAuth, clientWorkspaceController.renderPage('staff'));
router.get('/settings', requireClientAuth, clientHubController.getSettings);
router.post('/hub/password', requireClientAuth, clientHubController.postChangePassword);
router.get('/settings/workspace', requireClientAuth, clientWorkspaceController.renderPage('settings'));
router.get('/security', requireClientAuth, clientWorkspaceController.renderPage('security'));
router.get('/reports/export.csv', requireClientAuth, clientWorkspaceController.exportReportCsv);
router.get('/reports/central.pdf', requireClientAuth, clientWorkspaceController.downloadCentralCompanyReportPdf);
router.get('/transactions/:id/details', requireClientAuth, clientWorkspaceController.getTransactionDetails);
router.post('/api/smart-transfer/parse', requireClientAuth, retailTransferController.parseMessage);
router.post('/api/assistant/query', requireClientAuth, businessAssistantLimiter, clientWorkspaceController.askBusinessAssistant);
router.post('/customers/add', requireClientAuth, clientWorkspaceController.postCreateCustomer);
router.post('/customers/:id/toggle', requireClientAuth, clientWorkspaceController.postToggleCustomer);
router.post('/customers/:id/balance', requireClientAuth, clientWorkspaceController.postAdjustCustomerBalance);
router.post('/customers/:id/credit-limit', requireClientAuth, clientWorkspaceController.postUpdateCustomerCreditLimit);
router.post('/customers/:id/pricing', requireClientAuth, clientWorkspaceController.postUpdateCustomerPricing);
router.post('/settings/profile', requireClientAuth, clientWorkspaceController.postUpdateSettings);
router.post('/settings/password', requireClientAuth, clientWorkspaceController.postChangePassword);
router.post('/settings/theme', requireClientAuth, (req, res) => {
    if (req.session.accountType === 'company') {
        return clientWorkspaceController.postCompanyTheme(req, res);
    }
    return clientWorkspaceController.postClientTheme(req, res);
});
router.get('/company/staff', requireClientAuth, clientCompanyController.getStaffManagement);
router.post('/company/staff/add', requireClientAuth, clientCompanyController.postAddStaff);
router.post('/company/staff/:id/toggle', requireClientAuth, clientCompanyController.postToggleStaff);
router.post('/company/staff/:id/password', requireClientAuth, clientCompanyController.postResetStaffPassword);
router.post('/company/staff/:id/permissions', requireClientAuth, clientCompanyController.postUpdateStaffPermissions);
router.post('/agent/staff/add', requireClientAuth, clientAgentController.postAddStaff);
router.post('/agent/staff/:id/toggle', requireClientAuth, clientAgentController.postToggleStaff);
router.post('/agent/staff/:id/password', requireClientAuth, clientAgentController.postResetStaffPassword);
router.post('/agent/registration-requests/:id/approve', requireClientAuth, clientAgentController.postApproveClientRequest);
router.post('/agent/registration-requests/:id/reject', requireClientAuth, clientAgentController.postRejectClientRequest);

// ===============================================
// 🚀 Sub-Accounts Routes
// ===============================================
router.get('/sub-accounts', requireClientAuth, clientDashboardController.getSubAccounts);
router.post('/sub-accounts/add', requireClientAuth, clientDashboardController.postAddSubAccount);
router.post('/sub-accounts/settle/:id', requireClientAuth, (req, _res, next) => {
    req.body.operation = req.body.type === 'add' ? 'customer_payment' : 'customer_payout';
    next();
}, clientWorkspaceController.postAdjustCustomerBalance);
router.post('/sub-accounts/toggle/:id', requireClientAuth, clientDashboardController.postToggleSubAccount);

// ===============================================
// 💸 Transaction Routes
// ===============================================
// The transfer form is submitted as multipart/form-data when an identity image
// is attached. Parse it before checking the optional operation PIN so the PIN
// field is available on req.body for company and agency accounts.
router.post('/transfer', requireClientAuth, clientDocumentUpload.single('idCardImage'), requireOperationPin, clientTransactionController.postTransfer);
router.post('/balance-transfer/lookup', requireClientAuth, clientTransactionController.lookupBalanceTransferTarget);
router.post('/balance-transfer', requireClientAuth, requireOperationPin, clientTransactionController.postBalanceTransfer);
router.post('/buy-card', requireClientAuth, clientTransactionController.postBuyCard);
router.post('/complaint', requireClientAuth, clientTransactionController.postComplaint);
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireClientAuth, clientTransactionController.getProxyImage);

// ===============================================
// 📞 Support Routes
// ===============================================
router.get('/support', requireClientAuth, async (req, res) => {
    try {
        const context = await businessPortalService.loadPageContext(req, 'support');
        return res.render('client/workspace', context);
    } catch (error) {
        if (error.message === 'NOT_BUSINESS_PORTAL') {
            try {
                const { account } = await getSupportIdentity(req);
                const walletHub = isWalletHubSession(req.session.accountType, account.role);
                const { clientThemeLocals } = require('../utils/clientPortalTheme');
                return res.render('client/support', {
                    account,
                    accountType: req.session.accountType,
                    walletHub,
                    retailModern: walletHub,
                    user: account,
                    canRequestDeposit: canRequestRetailDeposit(req.session.accountType, account.role),
                    csrfToken: req.session.csrfToken || '',
                    ...clientThemeLocals(account, req.session.clientTheme)
                });
            } catch (e) {
                console.error('[Support] identity/render failed:', e);
                return res.redirect('/client/dashboard?supportError=1');
            }
        }
        if (error.message === 'FORBIDDEN_PAGE') {
            return businessPortalService.redirectForbiddenPage(req, res);
        }
        console.error('[Support] render failed:', error.message);
        return res.redirect('/client/logout');
    }
});

router.__test = { endUnauthorizedClientSession };

module.exports = router;
