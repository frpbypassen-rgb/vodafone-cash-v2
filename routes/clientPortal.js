// routes/clientPortal.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const Notification = require('../models/Notification');
const { resolveClientNotificationUserIds } = require('../services/clientNotificationService');
const { setPortalSupportReplyChannel } = require('../services/whatChimpSupportService');
const WebPushSubscription = require('../models/WebPushSubscription');
const Settings = require('../models/Settings');
const { activatePendingRateUpdate } = require('../services/rateChangeService');
const { buildPendingRateAlertForClient } = require('../services/rateAlerts/rateAlertAudienceService');
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

    if (req.session.accountType === 'agent_staff') {
        const employee = await AgentEmployee.findById(req.session.clientId).select('status agentId').lean();
        if (!employee || employee.status !== 'active') return false;

        const agent = await User.findById(employee.agentId).select('status role').lean();
        return Boolean(agent && agent.status === 'active' && agent.role === 'agent');
    }

    const user = await User.findById(req.session.clientId).select('status').lean();
    return Boolean(user && user.status === 'active');
};

const requireClientAuth = async (req, res, next) => {
    try {
        // The mandatory MFA page uses one shared completion flow. If an
        // executor reaches the customer fallback URL after enrolment, return
        // it to its own dashboard instead of ending the valid session.
        if (req.session?.isExecutorLoggedIn && req.session?.executorId) {
            return res.redirect('/executor-portal/dashboard');
        }
        if (req.session?.mfaEnrollmentRequired) return res.redirect('/security/mfa-enroll');
        if (await isActiveClientSession(req)) return next();
        return endUnauthorizedClientSession(req, res);
    } catch (_error) {
        return endUnauthorizedClientSession(req, res);
    }
};

const getSupportIdentity = async (req) => {
    if (req.session.accountType === 'company') {
        return { account: await ClientEmployee.findById(req.session.clientId), entityType: 'client_company' };
    }
    if (req.session.accountType === 'agent_staff') {
        return { account: await AgentEmployee.findById(req.session.clientId), entityType: 'client_user' };
    }
    if (req.session.accountType === 'sub_client') {
        return { account: await SubAccount.findById(req.session.clientId), entityType: 'sub_client' };
    }
    return { account: await User.findById(req.session.clientId), entityType: 'client_user' };
};

const parseSupportImage = (imageBase64) => {
    if (!imageBase64) return null;
    const match = String(imageBase64).match(/^data:image\/(jpeg|jpg|png|webp);base64,([a-z0-9+/=\r\n]+)$/i);
    if (!match) throw new Error('INVALID_SUPPORT_IMAGE');
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length || buffer.length > 4 * 1024 * 1024) throw new Error('INVALID_SUPPORT_IMAGE');
    return {
        buffer,
        extension: ['jpeg', 'jpg'].includes(match[1].toLowerCase()) ? '.jpg' : `.${match[1].toLowerCase()}`
    };
};

// Controllers
const clientAuthController = require('../controllers/clientAuthController');
const clientDashboardController = require('../controllers/clientDashboardController');
const clientTransactionController = require('../controllers/clientTransactionController');
const clientCompanyController = require('../controllers/clientCompanyController');
const clientAgentController = require('../controllers/clientAgentController');
const clientWorkspaceController = require('../controllers/clientWorkspaceController');
const clientDepositController = require('../controllers/clientDepositController');
const businessPortalService = require('../services/businessPortalService');

const clientDocumentUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, path.join(__dirname, '../uploads')),
        filename: (_req, file, callback) => {
            const extension = file.mimetype === 'image/png'
                ? '.png'
                : file.mimetype === 'image/webp'
                    ? '.webp'
                    : '.jpg';
            callback(null, `client-document-${crypto.randomUUID()}${extension}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
        const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
        if (!allowed.has(file.mimetype)) return callback(new Error('INVALID_DOCUMENT_TYPE'));
        return callback(null, true);
    }
});

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
router.get('/register/agent-lookup', clientAuthController.lookupAgent);
router.post('/register', clientAuthController.postRegister);
router.get('/verify', clientAuthController.getVerify);
router.post('/verify', otpVerifyLimiter, clientAuthController.postVerify);
router.get('/logout', clientAuthController.logout);

// ===============================================
// 📊 Dashboard Routes
// ===============================================
router.get('/dashboard', requireClientAuth, clientDashboardController.getDashboard);
router.get('/deposits', requireClientAuth, clientDepositController.getDepositsPage);
router.get('/api/deposits', requireClientAuth, clientDepositController.getDepositRequests);
router.post('/api/deposits', requireClientAuth, clientDepositController.postDepositRequest);
router.get('/profile-photo', requireClientAuth, clientDashboardController.getProfilePhoto);
router.post('/profile', requireClientAuth, clientDashboardController.postUpdateOwnProfile);
router.get('/api/transactions', requireClientAuth, clientDashboardController.getApiTransactions);
router.get('/api/rates', requireClientAuth, clientWorkspaceController.getCurrentRates);
router.get('/services', requireClientAuth, clientWorkspaceController.renderPage('services'));
router.get('/services/:serviceKey', requireClientAuth, clientWorkspaceController.renderPage('service_workbench'));
router.get('/smart-transfer', requireClientAuth, clientWorkspaceController.renderPage('smart_transfer'));
router.get('/internal-transfer', requireClientAuth, clientWorkspaceController.renderPage('internal_transfer'));
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
router.get('/settings', requireClientAuth, clientWorkspaceController.renderPage('settings'));
router.get('/security', requireClientAuth, clientWorkspaceController.renderPage('security'));
router.get('/reports/export.csv', requireClientAuth, clientWorkspaceController.exportReportCsv);
router.get('/reports/central.pdf', requireClientAuth, clientWorkspaceController.downloadCentralCompanyReportPdf);
router.get('/transactions/:id/details', requireClientAuth, clientWorkspaceController.getTransactionDetails);
router.post('/api/smart-transfer/parse', requireClientAuth, clientWorkspaceController.parseSmartTransferMessage);
router.post('/api/assistant/query', requireClientAuth, businessAssistantLimiter, clientWorkspaceController.askBusinessAssistant);
router.post('/customers/add', requireClientAuth, clientWorkspaceController.postCreateCustomer);
router.post('/customers/:id/toggle', requireClientAuth, clientWorkspaceController.postToggleCustomer);
router.post('/customers/:id/balance', requireClientAuth, clientWorkspaceController.postAdjustCustomerBalance);
router.post('/customers/:id/credit-limit', requireClientAuth, clientWorkspaceController.postUpdateCustomerCreditLimit);
router.post('/customers/:id/pricing', requireClientAuth, clientWorkspaceController.postUpdateCustomerPricing);
router.post('/settings/profile', requireClientAuth, clientWorkspaceController.postUpdateSettings);
router.post('/settings/password', requireClientAuth, clientWorkspaceController.postChangePassword);
router.get('/company/staff', requireClientAuth, clientCompanyController.getStaffManagement);
router.post('/company/staff/add', requireClientAuth, clientCompanyController.postAddStaff);
router.post('/company/staff/:id/toggle', requireClientAuth, clientCompanyController.postToggleStaff);
router.post('/company/staff/:id/password', requireClientAuth, clientCompanyController.postResetStaffPassword);
router.post('/agent/staff/add', requireClientAuth, clientAgentController.postAddStaff);
router.post('/agent/staff/:id/toggle', requireClientAuth, clientAgentController.postToggleStaff);
router.post('/agent/staff/:id/password', requireClientAuth, clientAgentController.postResetStaffPassword);
router.post('/agent/registration-requests/:id/approve', requireClientAuth, clientAgentController.postApproveClientRequest);
router.post('/agent/registration-requests/:id/reject', requireClientAuth, clientAgentController.postRejectClientRequest);
router.get('/api/notifications/unread', requireClientAuth, async (req, res) => {
    try {
        const userIds = await resolveClientNotificationUserIds({
            accountType: req.session.accountType,
            clientId: req.session.clientId
        });

        if (!userIds.length) return res.json({ success: true, count: 0, notifications: [] });

          // تغييرات الأسعار مستبعدة من صندوق الإشعارات وتعرض عبر القناة الحية.
          // لا نحذف سجلات من طلب GET متكرر، لأن ذلك يحول كل تحديث للواجهة إلى كتابة.
        const notifications = await Notification.find({
            userId: { $in: userIds },
            audience: { $in: ['client', 'all'] },
            isRead: false,
            type: { $ne: 'rate_change' }
        }).sort({ createdAt: -1 }).limit(10).lean();

        return res.json({ success: true, count: notifications.length, notifications });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

router.get('/api/rate-alerts/current', requireClientAuth, async (req, res) => {
    try {
        await activatePendingRateUpdate({ app: req.app });
        const settings = await Settings.findOne({}).lean() || {};
        const alert = await buildPendingRateAlertForClient({
            accountType: req.session.accountType,
            clientId: req.session.clientId,
            settings
        });
        return res.json({ success: true, alert });
    } catch (error) {
        console.error('[client/rate-alerts/current] failed:', error.message);
        return res.status(500).json({ success: false, error: 'RATE_ALERT_LOOKUP_FAILED' });
    }
});

router.post('/api/rate-alerts/subscribe', requireClientAuth, async (req, res) => {
    try {
        const subscription = req.body?.subscription;
        const endpoint = String(subscription?.endpoint || '').trim();
        if (!endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
            return res.status(422).json({ success: false, error: 'INVALID_PUSH_SUBSCRIPTION' });
        }
        await WebPushSubscription.findOneAndUpdate(
            { endpoint },
            {
                $set: {
                    subscription,
                    userId: String(req.session.clientId),
                    accountType: String(req.session.accountType || 'client'),
                    active: true,
                    lastError: ''
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'PUSH_SUBSCRIPTION_FAILED' });
    }
});

router.post('/api/notifications/:id/read', requireClientAuth, async (req, res) => {
    try {
        const userIds = await resolveClientNotificationUserIds({
            accountType: req.session.accountType,
            clientId: req.session.clientId
        });

        if (!userIds.length) return res.status(404).json({ success: false });

        const found = await Notification.findOne({
            _id: req.params.id,
            userId: { $in: userIds },
            audience: { $in: ['client', 'all'] }
        }).select('_id type metadata').lean();

        if (!found) return res.status(404).json({ success: false });

        const campaignReference = String(found.metadata?.campaignReference || '').trim();
        const filter = found.type === 'rate_change' && campaignReference
            ? {
                userId: { $in: userIds },
                audience: { $in: ['client', 'all'] },
                isRead: false,
                $or: [
                    { _id: found._id },
                    { type: 'rate_change', 'metadata.campaignReference': campaignReference }
                ]
            }
            : { _id: found._id, userId: { $in: userIds }, audience: { $in: ['client', 'all'] } };

        await Notification.updateMany(filter, { $set: { isRead: true } });

        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

router.post('/api/notifications/read-all', requireClientAuth, async (req, res) => {
    try {
        const userIds = await resolveClientNotificationUserIds({
            accountType: req.session.accountType,
            clientId: req.session.clientId
        });

        if (userIds.length) {
            await Notification.updateMany({
                userId: { $in: userIds },
                audience: { $in: ['client', 'all'] },
                isRead: false
            }, { $set: { isRead: true } });
        }

        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

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
                return res.render('client/support', { account, accountType: req.session.accountType });
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

router.get('/api/support/messages', requireClientAuth, async (req, res) => {
    try {
        const { account, entityType } = await getSupportIdentity(req);
        if (!account) return res.status(401).json({ success: false, error: 'Unauthorized' });

        let ticket = await SupportTicket.findOne({ entityType, entityId: account._id, status: { $ne: 'closed' } }).sort({ createdAt: -1 });
        if (!ticket) {
            ticket = new SupportTicket({
                entityType,
                entityId: account._id,
                telegramId: account.phone || account.webUsername,
                name: account.name || 'مستخدم البوابة',
                phone: account.phone || 'غير مسجل',
                messages: []
            });
            await ticket.save();
        }
        if (ticket.unreadUser > 0) {
            ticket.unreadUser = 0;
            await ticket.save();
        }
        res.json({ success: true, messages: ticket.messages });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/support/messages', requireClientAuth, async (req, res) => {
    let storedImagePath = null;
    try {
        const text = String(req.body.text || '').trim().slice(0, 1000);
        const parsedImage = parseSupportImage(req.body.imageBase64);
        if (!text && !parsedImage) {
            return res.status(400).json({ success: false, error: 'اكتب رسالة أو أرفق صورة.' });
        }

        const { account, entityType } = await getSupportIdentity(req);
        if (!account) return res.status(401).json({ success: false, error: 'Unauthorized' });

        if (businessPortalService.isCompanyDepositCreateIntent(text)) {
            const workspace = await businessPortalService.resolveWorkspace(req);
            if (!businessPortalService.canCreateCompanyDepositRequest(workspace)) {
                return res.status(403).json({
                    success: false,
                    error: 'إنشاء طلب الإيداع متاح لمدير التشغيل فقط. يمكنك متابعة الطلبات من صفحة الإيداع.'
                });
            }
        }

        let ticket = await SupportTicket.findOne({ entityType, entityId: account._id, status: { $ne: 'closed' } });
        if (!ticket) {
            ticket = new SupportTicket({
                entityType,
                entityId: account._id,
                telegramId: account.phone || account.webUsername,
                name: account.name || 'مستخدم البوابة',
                phone: account.phone || 'غير مسجل',
                messages: []
            });
        }

        let imageUrl = null;
        if (parsedImage) {
            const fileName = `support_${crypto.randomUUID()}${parsedImage.extension}`;
            storedImagePath = path.join(__dirname, '../uploads/', fileName);
            await fs.promises.writeFile(storedImagePath, parsedImage.buffer);
            imageUrl = `/uploads/${fileName}`;
        }

        const newMessage = {
            sender: 'user',
            senderName: account.name || account.webUsername,
            text,
            imageUrl,
            channel: 'portal',
            direction: 'inbound',
            createdAt: new Date()
        };
        ticket.messages.push(newMessage);
        setPortalSupportReplyChannel(ticket);
        ticket.status = 'open';
        ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1;
        ticket.updatedAt = new Date();
        await ticket.save();
        req.app.get('io')?.emit('support:ticket-updated', {
            ticketId: String(ticket._id),
            channel: ticket.channel || 'portal',
            direction: 'inbound',
            status: ticket.status
        });

        return res.json({ success: true, message: newMessage });
    } catch (error) {
        if (storedImagePath) fs.promises.unlink(storedImagePath).catch(() => {});
        const invalidImage = error.message === 'INVALID_SUPPORT_IMAGE';
        return res.status(invalidImage ? 400 : 500).json({
            success: false,
            error: invalidImage ? 'الصورة غير صالحة أو تتجاوز 4MB.' : 'تعذر إرسال الرسالة.'
        });
    }
});

module.exports = router;
