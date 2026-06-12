// routes/clientPortal.js
const express = require('express');
const router = express.Router();
const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');

// Middleware
const endUnauthorizedClientSession = (req, res) => {
    const sendUnauthorized = () => {
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.redirect('/login');
    };

    if (!req.session) return sendUnauthorized();
    return req.session.destroy(sendUnauthorized);
};

const isActiveClientSession = async (req) => {
    if (!req.session.isClientLoggedIn || !req.session.clientId) return false;

    if (req.session.accountType === 'company') {
        const employee = await ClientEmployee.findById(req.session.clientId).select('status companyId').lean();
        if (!employee || employee.status !== 'active') return false;

        const company = await ClientCompany.findById(employee.companyId).select('status').lean();
        return Boolean(company && company.status === 'active');
    }

    if (req.session.accountType === 'sub_client') {
        const subAccount = await SubAccount.findById(req.session.clientId).select('status').lean();
        return Boolean(subAccount && subAccount.status === 'active');
    }

    const user = await User.findById(req.session.clientId).select('status').lean();
    return Boolean(user && user.status === 'active');
};

const requireClientAuth = async (req, res, next) => {
    try {
        if (await isActiveClientSession(req)) return next();
        return endUnauthorizedClientSession(req, res);
    } catch (_error) {
        return endUnauthorizedClientSession(req, res);
    }
};

// Controllers
const clientAuthController = require('../controllers/clientAuthController');
const clientDashboardController = require('../controllers/clientDashboardController');
const clientTransactionController = require('../controllers/clientTransactionController');

router.get('/', (req, res) => {
    if (req.session.isClientLoggedIn && req.session.clientId) {
        return res.redirect('/client/dashboard');
    }
    return res.redirect('/login');
});

// ===============================================
// 👤 Auth Routes
// ===============================================
router.get('/login', (req, res) => {
    if (req.session.isClientLoggedIn && req.session.clientId) {
        return res.redirect('/client/dashboard');
    }
    return res.redirect('/login');
});
router.post('/login', (req, res) => res.redirect(307, '/login'));
router.get('/register', clientAuthController.getRegister);
router.post('/register', clientAuthController.postRegister);
router.get('/verify', clientAuthController.getVerify);
router.post('/verify', clientAuthController.postVerify);
router.get('/logout', clientAuthController.logout);

// ===============================================
// 📊 Dashboard Routes
// ===============================================
router.get('/dashboard', requireClientAuth, clientDashboardController.getDashboard);
router.get('/api/transactions', requireClientAuth, clientDashboardController.getApiTransactions);

// ===============================================
// 🚀 Sub-Accounts Routes
// ===============================================
router.get('/sub-accounts', requireClientAuth, clientDashboardController.getSubAccounts);
router.post('/sub-accounts/add', requireClientAuth, clientDashboardController.postAddSubAccount);
router.post('/sub-accounts/settle/:id', requireClientAuth, clientDashboardController.postSettleSubAccount);
router.post('/sub-accounts/toggle/:id', requireClientAuth, clientDashboardController.postToggleSubAccount);

// ===============================================
// 💸 Transaction Routes
// ===============================================
router.post('/transfer', requireClientAuth, clientTransactionController.postTransfer);
router.post('/balance-transfer/lookup', requireClientAuth, clientTransactionController.lookupBalanceTransferTarget);
router.post('/balance-transfer', requireClientAuth, clientTransactionController.postBalanceTransfer);
router.post('/buy-card', requireClientAuth, clientTransactionController.postBuyCard);
router.post('/complaint', requireClientAuth, clientTransactionController.postComplaint);
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireClientAuth, clientTransactionController.getProxyImage);

// ===============================================
// 📞 Support Routes
// ===============================================
router.get('/support', requireClientAuth, async (req, res) => {
    try {
        const isEmployee = req.session.accountType === 'company';
        const Model = isEmployee ? ClientEmployee : User;
        const account = await Model.findById(req.session.clientId);
        res.render('client/support', { account, accountType: req.session.accountType });
    } catch (e) { res.status(500).send('Error'); }
});

router.get('/api/support/messages', requireClientAuth, async (req, res) => {
    try {
        const isEmployee = req.session.accountType === 'company';
        const Model = isEmployee ? ClientEmployee : User;
        const account = await Model.findById(req.session.clientId);
        const phone = account.phone || account.webUsername;

        let ticket = await SupportTicket.findOne({ $or: [{ userPhone: phone }, { webUsername: phone }], status: { $ne: 'closed' } }).sort({ createdAt: -1 });
        if (!ticket) {
            ticket = new SupportTicket({ entityType: 'client', entityId: account._id, name: account.name, phone: account.phone || 'غير مسجل', webUsername: account.webUsername || 'غير مسجل', messages: [] });
            await ticket.save();
        }
        ticket.unreadUser = 0; await ticket.save();
        res.json({ success: true, messages: ticket.messages });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/support/messages', requireClientAuth, async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        const isEmployee = req.session.accountType === 'company';
        const Model = isEmployee ? ClientEmployee : User;
        const account = await Model.findById(req.session.clientId);
        const phone = account.phone || account.webUsername;

        let ticket = await SupportTicket.findOne({ $or: [{ userPhone: phone }, { webUsername: phone }], status: { $ne: 'closed' } });
        if (!ticket) {
            ticket = new SupportTicket({ entityType: 'client', entityId: account._id, name: account.name, phone: account.phone || 'غير مسجل', webUsername: account.webUsername || 'غير مسجل', messages: [] });
        }

        let imageUrl = null;
        if (imageBase64) {
            const fs = require('fs'); const path = require('path');
            const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
            const fileName = `support_${Date.now()}_${Math.round(Math.random()*1000)}.jpg`;
            const uploadPath = path.join(__dirname, '../uploads/', fileName);
            fs.writeFileSync(uploadPath, base64Data, 'base64');
            imageUrl = `/uploads/${fileName}`;
        }

        const newMessage = { sender: 'user', senderName: account.name, text: text, imageUrl, createdAt: new Date() };
        ticket.messages.push(newMessage); ticket.status = 'pending'; ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1; ticket.updatedAt = new Date(); await ticket.save();

        res.json({ success: true, message: newMessage });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
