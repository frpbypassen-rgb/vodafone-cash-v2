const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const Employee = require('../models/Employee');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const Ledger = require('../models/Ledger');
const RegistrationRequest = require('../models/RegistrationRequest');
const SupportTicket = require('../models/SupportTicket');
const Notification = require('../models/Notification');

const { authenticateJWT } = require('../middlewares/jwtAuth');
const correlationId = require('../middlewares/correlationId');
const requireIdempotencyKey = require('../middlewares/requireIdempotencyKey');
const { logAction } = require('../services/auditService');
const { proofSourceUrl, saveProofImage, streamProofImage } = require('../services/proofStorageService');
const authController = require('../controllers/auth/authController');
const transferService = require('../services/transferService');
const { deviceTrustMiddleware } = require('../src/Presentation/Middlewares/deviceTrustMiddleware');
const { mfaMiddleware } = require('../src/Presentation/Middlewares/mfaMiddleware');
const { buildMobileRateContract, buildCompanyRateContract, applyRateMargin } = require('../utils/rateHelper');
const { getTransferServiceLabel } = require('../utils/mobileTransferServiceCatalog');
const agentService = require('../services/mobileAgentSubAccountService');
const {
    createSubAccountValidator,
    updateCreditLimitValidator,
    settlementValidator,
    updateStatusValidator,
    paginationValidator
} = require('../validators/mobileAgentSubAccountValidators');
const {
    loginValidator,
    refreshTokenValidator,
    transferValidator,
    cancelTaskValidator,
    completeTaskValidator,
    clientReportsValidator,
    lookupValidator,
    balanceTransferValidator,
    complaintValidator,
    depositRequestValidator,
    editAmountValidator,
    returnTaskValidator,
    createEmployeeValidator,
    resetPasswordValidator,
    executorReportsValidator,
    executorSupportMessageValidator
} = require('../validators/mobileValidators');

const mobileWebParityService = require('../services/mobileWebParityService');
const mobileWebParityMapper = require('../mappers/mobileWebParityMapper');
const { resolveClientNotificationUserIds } = require('../services/clientNotificationService');
const {
    directRegisterValidator,
    newRegisterValidator,
    companyRegisterValidator,
    agentRegisterValidator
} = require('../validators/mobileRegistrationValidators');
const { sendMobileError, mobileErrorHandler } = require('../mappers/mobileErrorMapper');
const { checkRegistrationIdentityAvailability } = require('../services/registrationIdentityService');
const { customerNoteFromTransaction } = require('../utils/transactionNotes');

const router = express.Router();

const appendAdminNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

const customerFacingNotes = (notes) => {
    const raw = String(notes || '').trim();
    if (!raw) return null;
    const beforeApiLog = raw.split(/---\s*سجل\s+الـ\s+API/i)[0].trim();
    const legacyTransferMatch = beforeApiLog.match(/(?:تحويل رصيد صادر إلى|تحويل رصيد وارد من).*\|\s*(.+)$/);
    const systemPatterns = [
        /^سبب الرفض:/,
        /^\[تم /,
        /^\[فشل /,
        /^\[معلقة /,
        /^\[رقم الإلغاء:/,
        /^تحويل رصيد صادر إلى/,
        /^تحويل رصيد وارد من/,
        /^تمويل نقطة بيع/,
        /^سحب رصيد من نقطة بيع/,
        /^\[طلب وارد عبر API/
    ];
    const lines = legacyTransferMatch
        ? [legacyTransferMatch[1].trim()]
        : beforeApiLog.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => {
            if (/رقم المحول|الرقم المرجعي|مرجع|reference|ref/i.test(line)) return true;
            return !systemPatterns.some((pattern) => pattern.test(line));
        });
    return lines.filter(Boolean).join('\n').trim() || null;
};

const RECEIPT_TICKET_TTL_MS = 2 * 60 * 1000;
const receiptTickets = new Map();

const rateLimitHandler = (message) => (req, res) => {
    return sendMobileError(res, 429, 'TOO_MANY_REQUESTS', message, req.correlationId);
};

const sendServerError = (res, req, message = 'حدث خطأ داخلي، يرجى المحاولة لاحقاً') => {
    return sendMobileError(res, 500, 'SERVER_ERROR', message, req.correlationId);
};

const receiptTicketOwner = (user = {}) => [
    user.accountType || '',
    user.userId || '',
    user.userId || '',
    user.executorGroupId || ''
].join('|');

const createReceiptTicket = (fileUrl, user) => {
    const ticket = crypto.randomBytes(32).toString('hex');
    receiptTickets.set(ticket, {
        fileUrl,
        owner: receiptTicketOwner(user),
        expiresAt: Date.now() + RECEIPT_TICKET_TTL_MS
    });
    return ticket;
};

const consumeReceiptTicket = (ticket, user) => {
    const entry = receiptTickets.get(ticket);
    if (!entry) {
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'رابط الإيصال غير صالح أو انتهت صلاحيته' };
    }
    if (entry.expiresAt <= Date.now()) {
        receiptTickets.delete(ticket);
        return { ok: false, status: 404, code: 'NOT_FOUND', message: 'رابط الإيصال غير صالح أو انتهت صلاحيته' };
    }
    if (entry.owner !== receiptTicketOwner(user)) {
        return { ok: false, status: 403, code: 'FORBIDDEN', message: 'غير مصرح لك بعرض هذا المرفق' };
    }
    receiptTickets.delete(ticket);
    return { ok: true, entry };
};

const buildReceiptProxyUrl = (req, ticket) => {
    return `${req.protocol}://${req.get('host')}/api/mobile/transaction/image/content?ticket=${ticket}`;
};

const toExecutorTaskDto = (tx) => ({
    id: tx._id ? String(tx._id) : null,
    txId: tx.customId || null,
    transferType: tx.transferType || null,
    transferTypeLabel: getTransferServiceLabel(tx.transferType),
    amount: Number(tx.amount || 0),
    recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
    recipientName: tx.accountName || null,
    status: tx.status || 'unknown',
    createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
    emergencyAlert: tx.emergencyAlert || null
});

router.use(correlationId);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler('عدد كبير من محاولات الدخول، يرجى الانتظار 15 دقيقة')
});

const transferLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler('معدل طلبات التحويل مرتفع جداً، يرجى الانتظار قليلاً')
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler('معدل الطلبات مرتفع جداً')
});

router.use(apiLimiter);

/**
 * @swagger
 * /login:
 *   post:
 *     summary: تسجيل الدخول لتطبيق الموبايل
 *     tags: [🔐 Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: نجاح تسجيل الدخول
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       400:
 *         description: خطأ في التحقق من البيانات المدخلة
 *       401:
 *         description: بيانات الدخول غير صحيحة
 *       423:
 *         description: الحساب مقفل مؤقتاً لمحاولات خاطئة
 */
const checkRegistrationUniqueness = (phone, username) => (
    checkRegistrationIdentityAvailability({ phone, username })
);

const normalizeMobileAgentCode = (value) => String(value || '').replace(/\D/g, '').slice(0, 4);

const findMobileAgentByCode = async (agentCode) => {
    const normalized = normalizeMobileAgentCode(agentCode);
    if (!/^\d{4}$/.test(normalized)) return null;
    return User.findOne({
        role: 'agent',
        status: 'active',
        $or: [{ accountCode: normalized }, { agentCode: normalized }]
    });
};

const buildAgentStaffTransactionQuery = async (agentStaffId) => {
    const emp = await AgentEmployee.findById(agentStaffId);
    if (!emp) return null;
    const agent = await User.findById(emp.agentId);
    if (!agent || agent.status !== 'active' || agent.role !== 'agent') return null;
    const subAccountIds = await SubAccount
        .find({ masterType: 'user', masterId: agent._id, status: { $ne: 'deleted' } })
        .distinct('_id');

    return {
        $or: [
            { userId: agent.phone, companyId: null },
            { userId: agent.webUsername, companyId: null },
            { userId: String(agent._id), companyId: null },
            { subAccountId: { $in: subAccountIds } }
        ].filter((condition) => {
            if (condition.userId !== undefined) return Boolean(condition.userId);
            return true;
        })
    };
};

router.get('/client/register/agent-lookup', async (req, res) => {
    try {
        const agent = await findMobileAgentByCode(req.query.code);
        if (!agent) {
            return sendMobileError(res, 404, 'INVALID_AGENT_CODE', 'رقم الوكيل غير صحيح أو غير نشط', req.correlationId);
        }
        return res.json({
            success: true,
            data: {
                code: agent.accountCode || agent.agentCode,
                name: agent.name || agent.webUsername
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'تعذر التحقق من رقم الوكيل');
    }
});

router.post('/client/register/direct', directRegisterValidator, async (req, res) => {
    try {
        let { fullName, phone, storeName, address, username, password } = req.body;
        if (username && !username.includes('@')) username += '@ahram.com';

        const uniqueCheck = await checkRegistrationUniqueness(phone, username);
        if (!uniqueCheck.success) {
            return sendMobileError(res, 400, 'REGISTRATION_FAILED', uniqueCheck.message, req.correlationId);
        }

        const regRequest = await RegistrationRequest.create({
            accountType: 'direct',
            fullName,
            phone,
            storeName,
            address,
            username,
            password,
            ...uniqueCheck.requestMetadata,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown',
            status: 'pending'
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedByName: fullName || username || 'unknown',
            result: 'معلق',
            metadata: { accountType: 'direct', phone, regRequestId: regRequest._id }
        });

        return res.status(200).json({
            success: true,
            message: 'تم تقديم طلب التسجيل بنجاح، وهو قيد المراجعة من قبل الإدارة',
            data: {
                refCode: regRequest.refCode,
                accountType: 'direct',
                fullName: regRequest.fullName,
                phone: regRequest.phone,
                storeName: regRequest.storeName,
                address: regRequest.address,
                username: regRequest.username,
                status: regRequest.status,
                createdAt: regRequest.createdAt.toISOString()
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء معالجة طلب التسجيل');
    }
});

router.post('/client/register/new', newRegisterValidator, async (req, res) => {
    try {
        let { fullName, phone, city, nationality, username, password, agentCode } = req.body;
        if (username && !username.includes('@')) username += '@ahram.com';

        agentCode = normalizeMobileAgentCode(agentCode);
        const agent = await findMobileAgentByCode(agentCode);
        if (!agent) {
            return sendMobileError(res, 400, 'INVALID_AGENT_CODE', 'كود الوكيل المدخل غير صالح أو غير نشط بالنظام', req.correlationId);
        }

        const uniqueCheck = await checkRegistrationUniqueness(phone, username);
        if (!uniqueCheck.success) {
            return sendMobileError(res, 400, 'REGISTRATION_FAILED', uniqueCheck.message, req.correlationId);
        }

        const regRequest = await RegistrationRequest.create({
            accountType: 'new',
            fullName,
            phone,
            city,
            nationality,
            username,
            password,
            agentCode,
            agentId: agent._id,
            agentName: agent.name || agent.webUsername,
            ...uniqueCheck.requestMetadata,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown',
            status: 'pending_agent'
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedByName: fullName || username || 'unknown',
            result: 'معلق لدى الوكيل',
            metadata: { accountType: 'new', phone, regRequestId: regRequest._id, agentCode, agentId: agent._id }
        });

        return res.status(200).json({
            success: true,
            message: 'تم تقديم طلب التسجيل بنجاح، وهو قيد موافقة الوكيل',
            data: {
                refCode: regRequest.refCode,
                accountType: 'new',
                fullName: regRequest.fullName,
                phone: regRequest.phone,
                city: regRequest.city,
                nationality: regRequest.nationality,
                username: regRequest.username,
                agentCode: regRequest.agentCode,
                agentName: regRequest.agentName,
                status: regRequest.status,
                createdAt: regRequest.createdAt.toISOString()
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء معالجة طلب التسجيل');
    }
});

router.post('/client/register/company', companyRegisterValidator, async (req, res) => {
    try {
        let { companyName, companyContact, companyPhone, companyEmail, username, password } = req.body;
        if (username && !username.includes('@')) username += '@ahram.com';

        const uniqueCheck = await checkRegistrationUniqueness(companyPhone, username);
        if (!uniqueCheck.success) {
            return sendMobileError(res, 400, 'REGISTRATION_FAILED', uniqueCheck.message, req.correlationId);
        }

        const regRequest = await RegistrationRequest.create({
            accountType: 'company',
            companyName,
            companyContact,
            companyPhone,
            companyEmail,
            username,
            password,
            ...uniqueCheck.requestMetadata,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown',
            status: 'pending'
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedByName: companyContact || username || 'unknown',
            result: 'معلق',
            metadata: { accountType: 'company', companyPhone, regRequestId: regRequest._id }
        });

        return res.status(200).json({
            success: true,
            message: 'تم تقديم طلب تسجيل الشركة بنجاح، وهو قيد المراجعة من قبل الإدارة',
            data: {
                refCode: regRequest.refCode,
                accountType: 'company',
                companyName: regRequest.companyName,
                companyContact: regRequest.companyContact,
                companyPhone: regRequest.companyPhone,
                companyEmail: regRequest.companyEmail,
                username: regRequest.username,
                status: regRequest.status,
                createdAt: regRequest.createdAt.toISOString()
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء معالجة طلب التسجيل');
    }
});

router.post('/client/register/agent', agentRegisterValidator, async (req, res) => {
    try {
        let { companyName, fullName, phone, address, city, companyEmail, username, password } = req.body;
        if (username && !username.includes('@')) username += '@ahram.com';

        const uniqueCheck = await checkRegistrationUniqueness(phone, username);
        if (!uniqueCheck.success) {
            return sendMobileError(res, 400, 'REGISTRATION_FAILED', uniqueCheck.message, req.correlationId);
        }

        const regRequest = await RegistrationRequest.create({
            accountType: 'agent',
            companyName,
            fullName,
            companyContact: fullName,
            phone,
            address,
            city,
            companyEmail,
            username,
            password,
            ...uniqueCheck.requestMetadata,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown',
            status: 'pending'
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedByName: fullName || username || 'unknown',
            result: 'معلق',
            metadata: { accountType: 'agent', phone, regRequestId: regRequest._id }
        });

        return res.status(200).json({
            success: true,
            message: 'تم تقديم طلب تسجيل الوكيل بنجاح، وهو قيد المراجعة من قبل الإدارة',
            data: {
                refCode: regRequest.refCode,
                accountType: 'agent',
                companyName: regRequest.companyName,
                fullName: regRequest.fullName,
                phone: regRequest.phone,
                address: regRequest.address,
                city: regRequest.city,
                companyEmail: regRequest.companyEmail,
                username: regRequest.username,
                status: regRequest.status,
                createdAt: regRequest.createdAt.toISOString()
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء معالجة طلب التسجيل');
    }
});

router.post('/login', loginLimiter, loginValidator, authController.login);

/**
 * @swagger
 * /refresh-token:
 *   post:
 *     summary: تجديد توكن الوصول المنتهي
 *     tags: [🔐 Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
 *     responses:
 *       200:
 *         description: تم تجديد توكن الوصول
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 token:
 *                   type: string
 *                 expiresIn:
 *                   type: number
 *                   example: 3600
 *       403:
 *         description: توكن غير صالح أو منتهي الصلاحية
 */
router.post('/refresh-token', refreshTokenValidator, authController.refreshToken);

/**
 * @swagger
 * /logout:
 *   post:
 *     summary: تسجيل الخروج وإبطال الجلسة
 *     tags: [🔐 Auth]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: تم تسجيل الخروج بنجاح
 */
router.post('/logout', authenticateJWT, authController.logout);

/**
 * @swagger
 * /client/home:
 *   get:
 *     summary: جلب رصيد العميل وسعر الصرف الحالي وحالة المنظومة
 *     tags: [👤 Client]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: نجاح جلب البيانات
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 balance:
 *                   type: number
 *                   example: 1500.5
 *                 exchangeRate:
 *                   type: number
 *                   example: 6.45
 *                 isOpen:
 *                   type: boolean
 *                   example: true
 *                 serverTime:
 *                   type: string
 *                   format: date-time
 */
const buildHomeRateResponse = async (req, res, userId, accountType, settings) => {
    let balance = 0;
    let tier = 1;
    let subAccount = null;
    let companyForRates = null;
    let masterForRates = null;

    if (accountType === 'client_company') {
        const emp = await ClientEmployee.findById(userId);
        if (emp) {
            const company = await ClientCompany.findById(emp.companyId);
            if (company) {
                balance = company.balance || 0;
                tier = company.tier || 1;
                companyForRates = company;
            }
        }
    } else if (accountType === 'client_user') {
        let user;
        if (req.tenant) {
            user = await User.findOne({ _id: userId, tenantId: req.tenant._id });
        } else {
            user = await User.findById(userId);
        }
        if (user) {
            balance = user.balance || 0;
            tier = user.tier || 1;
        }
    } else if (accountType === 'agent_staff') {
        const emp = await AgentEmployee.findById(userId);
        const agent = emp ? await User.findById(emp.agentId) : null;
        if (agent) {
            balance = agent.balance || 0;
            tier = agent.tier || 1;
        }
    } else if (accountType === 'sub_client') {
        subAccount = await SubAccount.findById(userId);
        if (subAccount) {
            balance = subAccount.balance || 0;
            if (subAccount.masterType === 'user') {
                masterForRates = await User.findById(subAccount.masterId);
            } else {
                masterForRates = await ClientCompany.findById(subAccount.masterId);
            }
            tier = masterForRates ? (masterForRates.tier || 1) : 1;
        }
    }

    let rateContract;
    if (accountType === 'sub_client' && subAccount) {
        const masterContract = subAccount.masterType === 'company' && masterForRates
            ? buildCompanyRateContract(masterForRates, settings)
            : buildMobileRateContract(tier, settings);
        const subServiceRates = applyRateMargin(masterContract.serviceRates, subAccount.customMargin);
        const subBaseRate = subServiceRates.vodafone || masterContract.baseExchangeRate;

        rateContract = {
            tier: masterContract.tier,
            tierLabel: masterContract.tierLabel,
            baseExchangeRate: masterContract.baseExchangeRate,
            exchangeRate: subBaseRate,
            serviceRates: subServiceRates,
            serviceCatalog: masterContract.serviceCatalog
        };
    } else if (companyForRates) {
        rateContract = buildCompanyRateContract(companyForRates, settings);
    } else {
        rateContract = buildMobileRateContract(tier, settings);
    }

    const responseData = {
        success: true,
        balance: Number(balance),
        ...rateContract,
        isOpen: !(settings && settings.isManualClosed),
        serverTime: new Date().toISOString()
    };

    if (accountType === 'sub_client' && subAccount) {
        if (!masterForRates) {
            if (subAccount.masterType === 'user') {
                masterForRates = await User.findById(subAccount.masterId);
            } else {
                masterForRates = await ClientCompany.findById(subAccount.masterId);
            }
        }
        const { buildContext } = require('../mappers/mobileAuthMapper');
        responseData.creditLimit = subAccount.creditLimit || 0;
        responseData.debt = balance < 0 ? Math.abs(balance) : 0;
        responseData.availableToSpend = balance + (subAccount.creditLimit || 0);
        responseData.context = buildContext(accountType, {
            masterName: masterForRates ? masterForRates.name : null,
            accountCode: subAccount.accountCode || ''
        });
    }

    return responseData;
};

router.get('/client/home', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        if (accountType === 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        const settings = await Settings.findOne({});
        const responseData = await buildHomeRateResponse(req, res, userId, accountType, settings);
        return res.json(responseData);
    } catch (e) {
        return sendServerError(res, req, 'خطأ داخلي');
    }
});

/**
 * @swagger
 * /client/exchange-rate:
 *   post:
 *     summary: الحصول على تحديث فوري لرصيد العميل وسعر الصرف
 *     tags: [👤 Client]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: نجاح جلب سعر الصرف وتحديثه
 */
router.post('/client/exchange-rate', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        if (accountType === 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        const settings = await Settings.findOne({});
        const responseData = await buildHomeRateResponse(req, res, userId, accountType, settings);
        return res.json(responseData);
    } catch (e) {
        return sendServerError(res, req, 'خطأ داخلي بالسيرفر');
    }
});

// ── Agent Management Routes ─────────────────────────────────────────
router.get('/agent/overview', authenticateJWT, agentService.getOverview);
router.get('/agent/sub-accounts', authenticateJWT, paginationValidator, agentService.getSubAccounts);
router.get('/agent/sub-accounts/:id', authenticateJWT, agentService.getSubAccountDetails);
router.post('/agent/sub-accounts', authenticateJWT, requireIdempotencyKey, createSubAccountValidator, agentService.createSubAccount);
router.patch('/agent/sub-accounts/:id/credit-limit', authenticateJWT, requireIdempotencyKey, updateCreditLimitValidator, agentService.updateCreditLimit);
router.post('/agent/sub-accounts/:id/settlements', authenticateJWT, requireIdempotencyKey, settlementValidator, agentService.executeSettlement);
router.patch('/agent/sub-accounts/:id/status', authenticateJWT, requireIdempotencyKey, updateStatusValidator, agentService.updateStatus);
router.get('/agent/sub-accounts/:id/transactions', authenticateJWT, paginationValidator, agentService.getTransactions);

/**
 * @swagger
 * /client/new-transfer:
 *   post:
 *     summary: إنشاء طلب تحويل مالي جديد
 *     tags: [👤 Client]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *         description: مفتاح فريد لمنع تكرار الحوالة
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TransferRequest'
 *     responses:
 *       200:
 *         description: تم تقديم طلب التحويل بنجاح
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TransferResponse'
 *       400:
 *         description: رصيد غير كافٍ أو خطأ في المدخلات
 *       409:
 *         description: تعارض في مفتاح منع التكرار (Idempotency Key)
 */
router.post(
    '/client/new-transfer',
    authenticateJWT,
    deviceTrustMiddleware,
    mfaMiddleware,
    transferLimiter,
    requireIdempotencyKey,
    transferValidator,
    async (req, res) => {
        try {
            const result = await transferService.createTransfer({
                userId: req.user.userId,
                accountType: req.user.accountType,
                transferData: req.body,
                req
            });

            const { statusCode, ...body } = result;
            return res.status(statusCode || 500).json(body);
        } catch (e) {
            return sendServerError(res, req, 'حدث خطأ داخلي أثناء معالجة الطلب');
        }
    }
);

/**
 * @swagger
 * /client/kyc/submit:
 *   post:
 *     summary: تقديم مستندات الهوية (KYC) للعميل
 *     tags: [👤 Client]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [documentType, fileUrl, fullName]
 *             properties:
 *               documentType:
 *                 type: string
 *                 enum: [id_card, passport, selfie]
 *               fileUrl:
 *                 type: string
 *               documentNumber:
 *                 type: string
 *               fullName:
 *                 type: string
 *               expiryDate:
 *                 type: string
 *     responses:
 *       200:
 *         description: تم تقديم مستند الهوية بنجاح
 *       400:
 *         description: بيانات غير مكتملة
 */
router.post('/client/kyc/submit', authenticateJWT, async (req, res) => {
    try {
        const { documentType, fileUrl, documentNumber, fullName, expiryDate } = req.body;
        const { kycService } = require('../src/Application/Services/KycService');
        
        const result = await kycService.submitDocument(req.user.userId, {
            documentType,
            fileUrl,
            documentNumber,
            fullName,
            expiryDate: expiryDate ? new Date(expiryDate) : undefined
        });

        if (!result.success) {
            return sendMobileError(res, 400, 'KYC_SUBMISSION_FAILED', result.message, req.correlationId);
        }

        return res.status(200).json({ success: true, message: result.message });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ داخلي أثناء معالجة مستندات التحقق');
    }
});

/**
 * @swagger
 * /client/kyc/status:
 *   get:
 *     summary: الاستعلام عن حالة التحقق (KYC) للعميل
 *     tags: [👤 Client]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: نجاح استرجاع الحالة
 */
router.get('/client/kyc/status', authenticateJWT, async (req, res) => {
    try {
        const { kycService } = require('../src/Application/Services/KycService');
        const statusResult = await kycService.getKycStatus(req.user.userId);
        return res.status(200).json({ success: true, data: statusResult });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ داخلي أثناء جلب حالة التحقق');
    }
});

/**
 * @swagger
 * /executor/live-tasks:
 *   get:
 *     summary: جلب المهام الحالية النشطة والإنذارات المخصصة للمنفذ
 *     tags: [🤖 Executor]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: نجاح جلب المهام
 */
router.get('/executor/live-tasks', authenticateJWT, async (req, res) => {
    try {
        const { executorGroupId, accountType } = req.user;
        if (accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        const queryTasks = {
            executorGroupId,
            status: { $in: ['processing', 'accepted'] }
        };
        if (req.tenant) queryTasks.tenantId = req.tenant._id;
        const tasks = await Transaction.find(queryTasks).sort({ createdAt: 1 }).lean();

        const queryAlerts = {
            executorGroupId,
            emergencyAlert: { $exists: true, $ne: null },
            status: { $in: ['processing', 'accepted'] }
        };
        if (req.tenant) queryAlerts.tenantId = req.tenant._id;
        const alerts = await Transaction.find(queryAlerts).lean();

        return res.json({
            success: true,
            data: tasks.map(toExecutorTaskDto),
            alerts: alerts.map(toExecutorTaskDto),
            pollIntervalSeconds: 5,
            serverTime: new Date().toISOString()
        });
    } catch (e) {
        return sendServerError(res, req);
    }
});

/**
 * @swagger
 * /executor/accept-task/{id}:
 *   post:
 *     summary: قبول مهمة تحويل معينة من قِبل المنفذ
 *     tags: [🤖 Executor]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: معرف عملية التحويل (ID)
 *     responses:
 *       200:
 *         description: تم قبول المهمة بنجاح
 *       409:
 *         description: تم سحب الطلب أو قبول العملية من قِبل زميل آخر
 */
router.post('/executor/accept-task/:id', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        const empQuery = { _id: userId };
        if (req.tenant) empQuery.tenantId = req.tenant._id;
        const emp = await Employee.findOne(empQuery).populate('groupId');
        if (!emp) {
            return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        }

        const groupId = emp.groupId && (emp.groupId._id || emp.groupId);
        if (!groupId) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'Ø§Ù„Ù…Ù†ÙØ° ØºÙŠØ± Ù…Ø±Ø¨ÙˆØ· Ø¨Ù…Ø¬Ù…ÙˆØ¹Ø© ØµØ§Ù„Ø­Ø©', req.correlationId);
        }

        const txQuery = {
            _id: req.params.id,
            status: 'processing',
            $or: [{ executorGroupId: groupId }, { managerGroupId: groupId }]
        };
        if (req.tenant) txQuery.tenantId = req.tenant._id;
        const tx = await Transaction.findOneAndUpdate(
            txQuery,
            { $set: { status: 'accepted', operatorId: emp._id.toString(), executorName: emp.name, emergencyAlert: undefined } },
            { new: true }
        );

        if (!tx) {
            return sendMobileError(res, 409, 'ALREADY_TAKEN', 'عذراً، تم سحب الطلب من قِبل زميل آخر', req.correlationId);
        }



        return res.json({ success: true });
    } catch (e) {
        return sendServerError(res, req);
    }
});

/**
 * @swagger
 * /executor/cancel-task/{id}:
 *   post:
 *     summary: إلغاء مهمة مقبولة وإرجاع رصيد العميل
 *     tags: [🤖 Executor]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: معرف العملية
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 example: "الرقم غير مسجل بالمحفظة"
 *     responses:
 *       200:
 *         description: تم الإلغاء وإرجاع الرصيد بنجاح
 */
router.post('/executor/cancel-task/:id', authenticateJWT, cancelTaskValidator, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { reason } = req.body;
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') throw new Error('FORBIDDEN');

        let tx;
        if (req.tenant) {
            tx = await Transaction.findOne({ _id: req.params.id, tenantId: req.tenant._id }).session(session);
        } else {
            tx = await Transaction.findById(req.params.id).session(session);
        }
        const empQuery = { _id: userId };
        if (req.tenant) empQuery.tenantId = req.tenant._id;
        const emp = await Employee.findOne(empQuery).session(session);
        if (!emp) throw new Error('EMPLOYEE_NOT_FOUND');

        if (!tx || tx.status !== 'accepted' || tx.operatorId !== emp._id.toString()) {
            throw new Error('INVALID_STATE');
        }

        let targetId;
        let TargetModel;
        if (tx.companyId) {
            TargetModel = ClientCompany;
            targetId = tx.companyId;
        } else if (tx.userId) {
            TargetModel = User;
            const userQuery = { phone: tx.userId };
            if (req.tenant) userQuery.tenantId = req.tenant._id;
            const user = await User.findOne(userQuery);
            targetId = user && user._id;
        }
        if (!TargetModel || !targetId) throw new Error('INVALID_STATE');

        const updatedClient = await TargetModel.findByIdAndUpdate(
            targetId,
            { $inc: { balance: tx.costLYD } },
            { new: true, session }
        );

        const ledgerEntry = new Ledger({
            entityId: targetId,
            entityModel: TargetModel.modelName,
            transactionId: tx.customId,
            type: 'REFUND',
            amount: tx.costLYD,
            balanceBefore: updatedClient.balance - tx.costLYD,
            balanceAfter: updatedClient.balance,
            description: `استرجاع تكلفة حوالة ملغاة (السبب: ${reason})`
        });
        await ledgerEntry.save({ session });

        tx.status = 'rejected';
        tx.adminNotes = appendAdminNoteText(tx.adminNotes, `[تم الإلغاء | المنفذ: ${emp.name} | السبب: ${reason}]`);
        await tx.save({ session });

        await session.commitTransaction();
        session.endSession();

        await logAction({
            action: 'TRANSFER_CANCELLED',
            req,
            performedById: emp._id,
            performedByModel: 'Employee',
            performedByName: emp.name,
            targetId: tx._id,
            targetModel: 'Transaction',
            oldData: { status: 'accepted', costLYD: tx.costLYD },
            newData: { status: 'rejected', reason },
            metadata: { customId: tx.customId, refundAmount: tx.costLYD }
        });

        return res.json({ success: true, message: 'تم الإلغاء وإرجاع الرصيد بنجاح' });
    } catch (e) {
        try {
            await session.abortTransaction();
            session.endSession();
        } catch (_) {}

        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        if (e.message === 'EMPLOYEE_NOT_FOUND') {
            return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        }
        if (e.message === 'INVALID_STATE') {
            return sendMobileError(res, 409, 'INVALID_STATE', 'فشل الإلغاء', req.correlationId);
        }
        return sendServerError(res, req, 'فشل الإلغاء');
    }
});

/**
 * @swagger
 * /executor/complete-task/{id}:
 *   post:
 *     summary: إكمال المهمة وإرسال إثبات التحويل (Base64)
 *     tags: [🤖 Executor]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: معرف العملية
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - imageBase64
 *             properties:
 *               imageBase64:
 *                 type: string
 *                 description: صورة الإثبات بصيغة Base64
 *                 example: "data:image/jpeg;base64,/9j/4AAQSkZJR..."
 *               senderPhone:
 *                 type: string
 *                 description: رقم الهاتف الذي تم التحويل منه
 *                 example: "01012345678"
 *     responses:
 *       200:
 *         description: تم إنهاء العملية بنجاح وإرسال الإثبات
 */
router.post('/executor/complete-task/:id', authenticateJWT, completeTaskValidator, async (req, res) => {
    try {
        const { imageBase64, senderPhone } = req.body;
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        if (!imageBase64) {
            return sendMobileError(res, 400, 'MALFORMED_IMAGE', 'يرجى إرفاق صورة الإثبات', req.correlationId);
        }

        let tx;
        if (req.tenant) {
            tx = await Transaction.findOne({ _id: req.params.id, tenantId: req.tenant._id });
        } else {
            tx = await Transaction.findById(req.params.id);
        }
        const empQuery = { _id: userId };
        if (req.tenant) empQuery.tenantId = req.tenant._id;
        const emp = await Employee.findOne(empQuery).populate('groupId');
        if (!emp) {
            return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        }
        if (!tx || tx.status !== 'accepted' || tx.operatorId !== emp._id.toString()) {
            return sendMobileError(res, 409, 'INVALID_STATE', 'الطلب غير متاح للإنهاء', req.correlationId);
        }

        if (emp.groupId && emp.groupId.parentGroupId) {
            await ExecutorGroup.findByIdAndUpdate(emp.groupId.parentGroupId, { $inc: { balance: -tx.amount } });
        }
        if (emp.groupId) {
            await ExecutorGroup.findByIdAndUpdate(emp.groupId._id, { $inc: { balance: -tx.amount } });
        }

        const savedFileId = saveProofImage(imageBase64, tx.customId || tx._id);

        tx.status = 'completed';
        tx.proofImage = savedFileId;
        tx.proofImages = Array.isArray(tx.proofImages) ? tx.proofImages : [];
        tx.proofImages.push(savedFileId);
        if (senderPhone) tx.executorSenderPhone = senderPhone;
        await tx.save();

        await logAction({
            action: 'TRANSFER_COMPLETED',
            req,
            performedById: emp._id,
            performedByModel: 'Employee',
            performedByName: emp.name,
            targetId: tx._id,
            targetModel: 'Transaction',
            oldData: { status: 'accepted' },
            newData: { status: 'completed', hasProofImage: Boolean(savedFileId), senderPhone: senderPhone || null },
            metadata: { customId: tx.customId, amount: tx.amount, transferType: tx.transferType }
        });

        return res.json({ success: true, message: 'تم إرسال الإثبات بنجاح' });
    } catch (e) {
        return sendServerError(res, req, 'خطأ في السيرفر');
    }
});

/**
 * @swagger
 * /transaction/image/content:
 *   get:
 *     summary: بث صورة إثبات الحوالة كـ Image Stream باستخدام التذكرة المؤقتة
 *     tags: [📁 Media]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: ticket
 *         required: true
 *         schema:
 *           type: string
 *         description: تذكرة صلاحية الصورة المؤقتة
 *     responses:
 *       200:
 *         description: دفق الصورة بنجاح (image/jpeg)
 *       404:
 *         description: التذكرة منتهية الصلاحية أو غير موجودة
 */
router.get('/transaction/image/content', authenticateJWT, async (req, res) => {
    try {
        const ticket = consumeReceiptTicket(req.query.ticket, req.user);
        if (!ticket.ok) {
            return sendMobileError(res, ticket.status, ticket.code, ticket.message, req.correlationId);
        }

        await streamProofImage(ticket.entry.fileUrl, res);
        return;
    } catch (e) {
        if (e && e.statusCode) {
            return sendMobileError(
                res,
                e.statusCode,
                e.code || 'SERVER_ERROR',
                e.statusCode === 404 ? 'تعذر العثور على صورة الإثبات' : 'تعذر تحميل الإيصال بأمان',
                req.correlationId
            );
        }
        return sendServerError(res, req, 'تعذر تحميل الإيصال بأمان');
    }
});

/**
 * @swagger
 * /transaction/image/{id}:
 *   get:
 *     summary: توليد تذكرة مؤقتة لعرض صورة إثبات العملية
 *     tags: [📁 Media]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: معرف عملية التحويل (ID)
 *     responses:
 *       200:
 *         description: تم توليد تذكرة الصورة
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 url:
 *                   type: string
 *                   example: "http://localhost:3000/api/mobile/transaction/image/content?ticket=..."
 *                 expiresIn:
 *                   type: number
 *                   example: 120
 */
router.get('/transaction/image/:id', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType, executorGroupId } = req.user;
        let tx;
        if (req.tenant) {
            tx = await Transaction.findOne({ _id: req.params.id, tenantId: req.tenant._id });
        } else {
            tx = await Transaction.findById(req.params.id);
        }
        if (!tx) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'العملية غير موجودة', req.correlationId);
        }

        let hasAccess = false;
        if (accountType === 'executor') {
            if (tx.executorGroupId && tx.executorGroupId.toString() === executorGroupId) hasAccess = true;
            if (tx.managerGroupId && tx.managerGroupId.toString() === executorGroupId) hasAccess = true;
        } else if (accountType === 'client_company') {
            const emp = await ClientEmployee.findById(userId);
            if (emp && tx.companyId && tx.companyId.toString() === emp.companyId.toString()) hasAccess = true;
        } else if (accountType === 'agent_staff') {
            const agentQuery = await buildAgentStaffTransactionQuery(userId);
            if (agentQuery) {
                const scopedTx = await Transaction.exists({ _id: tx._id, ...agentQuery });
                if (scopedTx) hasAccess = true;
            }
        } else if (accountType === 'client_user') {
            const requesterIds = [userId, req.user.telegramId].filter(Boolean).map(String);
            if (requesterIds.includes(String(tx.userId))) hasAccess = true;
            if (!hasAccess) {
                try {
                    const user = await User.findById(userId);
                    const allowedIds = [user && user._id, user && user.phone, user && user.webUsername]
                        .filter(Boolean)
                        .map(String);
                    if (allowedIds.includes(String(tx.userId))) hasAccess = true;
                } catch (_) {}
            }
        }

        if (!hasAccess) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'غير مصرح لك بعرض هذا المرفق', req.correlationId);
        }

        const photoId = tx.proofImages && tx.proofImages.length > 0 ? tx.proofImages[0] : tx.proofImage;
        if (!photoId) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'لا توجد صورة إثبات', req.correlationId);
        }

        // 🟢 قمنا بإلغاء التليجرام. يجب إرجاع رابط الصورة من النظام نفسه.
        const fileLink = { href: proofSourceUrl(photoId) };

        if (!fileLink) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'لا يمكن جلب الصورة، ربما انتهت صلاحيتها', req.correlationId);
        }

        const ticket = createReceiptTicket(fileLink.href, req.user);
        return res.json({
            success: true,
            url: buildReceiptProxyUrl(req, ticket),
            expiresIn: Math.floor(RECEIPT_TICKET_TTL_MS / 1000),
            serverTime: new Date().toISOString()
        });
    } catch (e) {
        return sendServerError(res, req, 'خطأ داخلي في الخادم');
    }
});

router.post('/client/tickets', authenticateJWT, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || typeof text !== 'string' || !text.trim()) {
            return sendMobileError(res, 400, 'VALIDATION_ERROR', 'نص الرسالة مطلوب لفتح تذكرة', req.correlationId);
        }

        const { userId, accountType } = req.user;
        let name = 'عميل';
        let phone = '';

        if (accountType === 'client_user') {
            const u = await User.findById(userId);
            if (u) { name = u.name; phone = u.phone; }
        } else if (accountType === 'client_company') {
            const emp = await ClientEmployee.findById(userId);
            if (emp) { name = emp.name; phone = emp.phone; }
        } else if (accountType === 'executor') {
            const emp = await Employee.findById(userId);
            if (emp) { name = emp.name; phone = emp.phone; }
        }

        const ticket = new SupportTicket({
            entityType: accountType,
            entityId: userId,
            name: name,
            phone: phone,
            status: 'open',
            messages: [{
                sender: 'user',
                senderName: name,
                text: text.trim(),
                createdAt: new Date()
            }]
        });

        await ticket.save();

        return res.status(201).json({
            success: true,
            ticket: {
                id: String(ticket._id),
                ticketId: ticket.ticketId,
                name: ticket.name,
                phone: ticket.phone,
                status: ticket.status,
                createdAt: ticket.createdAt.toISOString(),
                updatedAt: ticket.updatedAt.toISOString()
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء إنشاء التذكرة');
    }
});

router.get('/client/tickets', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;

        const query = { entityId: userId };
        const total = await SupportTicket.countDocuments(query);
        const tickets = await SupportTicket.find(query)
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        return res.status(200).json({
            success: true,
            tickets: tickets.map(t => ({
                id: String(t._id),
                ticketId: t.ticketId,
                name: t.name,
                phone: t.phone,
                status: t.status,
                unreadCount: t.unreadUser || 0,
                createdAt: t.createdAt.toISOString(),
                updatedAt: t.updatedAt.toISOString()
            })),
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء جلب قائمة التذاكر');
    }
});

router.get('/client/tickets/:id', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        const ticket = await SupportTicket.findOne({ _id: req.params.id, entityId: userId });
        if (!ticket) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'التذكرة غير موجودة أو غير مصرح لك بعرضها', req.correlationId);
        }

        if (ticket.unreadUser > 0) {
            ticket.unreadUser = 0;
            await ticket.save();
        }

        return res.status(200).json({
            success: true,
            ticket: {
                id: String(ticket._id),
                ticketId: ticket.ticketId,
                name: ticket.name,
                phone: ticket.phone,
                status: ticket.status,
                messages: ticket.messages.map(m => ({
                    sender: m.sender,
                    senderName: m.senderName,
                    text: m.text,
                    imageUrl: m.imageUrl || null,
                    createdAt: m.createdAt.toISOString()
                })),
                createdAt: ticket.createdAt.toISOString(),
                updatedAt: ticket.updatedAt.toISOString()
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء جلب تفاصيل التذكرة');
    }
});

router.post('/client/tickets/:id/reply', authenticateJWT, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || typeof text !== 'string' || !text.trim()) {
            return sendMobileError(res, 400, 'VALIDATION_ERROR', 'نص الرد مطلوب', req.correlationId);
        }

        const { userId } = req.user;
        const ticket = await SupportTicket.findOne({ _id: req.params.id, entityId: userId });
        if (!ticket) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'التذكرة غير موجودة أو غير مصرح لك بعرضها', req.correlationId);
        }

        const newMessage = {
            sender: 'user',
            senderName: ticket.name,
            text: text.trim(),
            createdAt: new Date()
        };

        ticket.messages.push(newMessage);
        ticket.status = 'open';
        ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1;
        await ticket.save();

        return res.status(200).json({
            success: true,
            message: {
                sender: newMessage.sender,
                senderName: newMessage.senderName,
                text: newMessage.text,
                createdAt: newMessage.createdAt.toISOString()
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء إضافة الرد');
    }
});

router.get('/client/transactions', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        let query = {};

        if (accountType === 'client_user') {
            const u = await User.findById(userId);
            if (!u) {
                return sendMobileError(res, 404, 'USER_NOT_FOUND', 'المستخدم غير موجود', req.correlationId);
            }
            query = {
                $or: [
                    { userId: u.phone },
                    { userId: u.webUsername },
                    { userId: String(u._id) }
                ]
            };
        } else if (accountType === 'client_company') {
            const emp = await ClientEmployee.findById(userId);
            if (!emp) {
                return sendMobileError(res, 404, 'USER_NOT_FOUND', 'المستخدم غير موجود', req.correlationId);
            }
            query = { companyId: emp.companyId };
        } else if (accountType === 'agent_staff') {
            query = await buildAgentStaffTransactionQuery(userId);
            if (!query) {
                return sendMobileError(res, 404, 'USER_NOT_FOUND', 'المستخدم غير موجود', req.correlationId);
            }
        } else {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        if (req.tenant) query.tenantId = req.tenant._id;

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
        const skip = (page - 1) * limit;

        const total = await Transaction.countDocuments(query);
        const txs = await Transaction.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        return res.status(200).json({
            success: true,
            transactions: txs.map(tx => ({
                id: String(tx._id),
                customId: tx.customId,
                transferType: tx.transferType,
                transferTypeLabel: getTransferServiceLabel(tx.transferType),
                recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
                recipientName: tx.accountName || null,
                amount: Number(tx.amount || 0),
                costLYD: Number(tx.costLYD || 0),
                exchangeRate: Number(tx.exchangeRate || 0),
                status: tx.status,
                createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
                notes: customerFacingNotes(customerNoteFromTransaction(tx)),
                hasProofImage: !!(tx.proofImage || (tx.proofImages && tx.proofImages.length > 0))
            })),
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء جلب قائمة العمليات');
    }
});

router.get('/client/notifications', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        if (!['client_user', 'client_company', 'sub_client', 'agent_staff'].includes(accountType)) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
        const userIds = await resolveClientNotificationUserIds({ accountType, clientId: userId });

        if (!userIds.length) {
            return res.status(200).json({
                success: true,
                notifications: [],
                pagination: { page, limit, total: 0, pages: 0 }
            });
        }

        const query = {
            userId: { $in: userIds },
            audience: { $in: ['client', 'all'] }
        };
        if (req.query.unreadOnly === 'true') query.isRead = false;

        const total = await Notification.countDocuments(query);
        const notifications = await Notification.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();

        return res.status(200).json({
            success: true,
            notifications: notifications.map((notification) => ({
                id: String(notification._id),
                title: notification.title,
                message: notification.message,
                type: notification.type || 'system_alert',
                isRead: Boolean(notification.isRead),
                txId: notification.txId || null,
                createdAt: notification.createdAt ? new Date(notification.createdAt).toISOString() : null
            })),
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء جلب الإشعارات');
    }
});

router.post('/client/notifications/:id/read', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        if (!['client_user', 'client_company', 'sub_client', 'agent_staff'].includes(accountType)) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        const userIds = await resolveClientNotificationUserIds({ accountType, clientId: userId });
        if (!userIds.length) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الإشعار غير موجود', req.correlationId);
        }

        const result = await Notification.updateOne({
            _id: req.params.id,
            userId: { $in: userIds },
            audience: { $in: ['client', 'all'] }
        }, { $set: { isRead: true } });

        if (!result.matchedCount) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الإشعار غير موجود', req.correlationId);
        }

        return res.status(200).json({ success: true });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء تحديث الإشعار');
    }
});

router.get('/client/transactions/:id', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        let tx;
        if (req.tenant) {
            tx = await Transaction.findOne({ _id: req.params.id, tenantId: req.tenant._id }).lean();
        } else {
            tx = await Transaction.findById(req.params.id).lean();
        }

        if (!tx) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'العملية غير موجودة', req.correlationId);
        }

        let hasAccess = false;
        if (accountType === 'client_user') {
            const u = await User.findById(userId);
            const allowedIds = u ? [u.phone, u.webUsername, String(u._id)].filter(Boolean).map(String) : [];
            if (allowedIds.includes(String(tx.userId))) hasAccess = true;
        } else if (accountType === 'client_company') {
            const emp = await ClientEmployee.findById(userId);
            if (emp && tx.companyId && String(tx.companyId) === String(emp.companyId)) {
                hasAccess = true;
            }
        } else if (accountType === 'agent_staff') {
            const agentQuery = await buildAgentStaffTransactionQuery(userId);
            if (agentQuery) {
                const scopedTx = await Transaction.exists({ _id: tx._id, ...agentQuery });
                if (scopedTx) hasAccess = true;
            }
        }

        if (!hasAccess) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'غير مصرح لك بعرض تفاصيل هذه العملية', req.correlationId);
        }

        return res.status(200).json({
            success: true,
            transaction: {
                id: String(tx._id),
                customId: tx.customId,
                transferType: tx.transferType,
                transferTypeLabel: getTransferServiceLabel(tx.transferType),
                recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
                recipientName: tx.accountName || null,
                amount: Number(tx.amount || 0),
                costLYD: Number(tx.costLYD || 0),
                exchangeRate: Number(tx.exchangeRate || 0),
                status: tx.status,
                createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
                notes: customerFacingNotes(customerNoteFromTransaction(tx)),
                hasProofImage: !!(tx.proofImage || (tx.proofImages && tx.proofImages.length > 0))
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء جلب تفاصيل العملية');
    }
});

// 📊 Client Reports Parity
router.post('/client/reports/filter', authenticateJWT, clientReportsValidator, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        const { dateType, dateValue } = req.body;
        const tenantId = req.tenant ? req.tenant._id : null;
        
        const result = await mobileWebParityService.getClientReports({
            userId,
            accountType,
            dateType,
            dateValue,
            tenantId
        });
        
        return res.json({
            success: true,
            data: mobileWebParityMapper.toClientReportDto(result),
            serverTime: new Date().toISOString()
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء جلب التقارير');
    }
});

// 💸 Client Balance Transfer Lookup
router.post('/client/balance-transfer/lookup', authenticateJWT, lookupValidator, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        const { targetAccountCode } = req.body;
        
        const target = await mobileWebParityService.lookupBalanceTransfer({
            userId,
            accountType,
            targetAccountCode
        });
        
        return res.json({
            success: true,
            target: mobileWebParityMapper.toBalanceTransferLookupDto(target)
        });
    } catch (e) {
        const knownMsg = {
            SESSION_EXPIRED: 'انتهت الجلسة. يرجى تسجيل الدخول مرة أخرى.',
            SOURCE_INACTIVE: 'حساب المرسل غير نشط.',
            TARGET_INACTIVE: 'الحساب المستلم غير نشط.',
            SAME_ACCOUNT: 'لا يمكن تحويل الرصيد إلى نفس الحساب.',
            INVALID_ACCOUNT_CODE: 'كود المستلم غير صالح.',
            TARGET_NOT_FOUND: 'لم يتم العثور على حساب بهذا الكود.'
        };
        Object.assign(knownMsg, {
            INVALID_RATE: 'سعر الصرف المسجل على العملية غير صالح.',
            ACCOUNT_NOT_FOUND: 'الحساب المرتبط بالعملية غير موجود.',
            LOCK_TIMEOUT: 'تعذر قفل العملية حالياً، يرجى المحاولة لاحقاً.'
        });
        if (knownMsg[e.message]) {
            const status = e.message === 'TARGET_NOT_FOUND' ? 404 : (e.message === 'SESSION_EXPIRED' ? 401 : 400);
            return sendMobileError(res, status, e.message, knownMsg[e.message], req.correlationId);
        }
        return sendServerError(res, req, 'تعذر التحقق من حساب المستلم');
    }
});

// 💸 Client Balance Transfer Execute (Idempotent)
router.post('/client/balance-transfer', authenticateJWT, requireIdempotencyKey, balanceTransferValidator, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        const { targetAccountCode, amount, notes } = req.body;
        
        const result = await mobileWebParityService.executeBalanceTransferIdempotent({
            userId,
            accountType,
            targetAccountCode,
            amount,
            notes,
            req
        });
        
        return res.json({
            success: true,
            message: `تم تحويل ${result.response.amount.toFixed(2)} LYD إلى ${result.response.targetName} بنجاح.`,
            ...mobileWebParityMapper.toBalanceTransferExecuteDto(result.response)
        });
    } catch (e) {
        const knownMsg = {
            SESSION_EXPIRED: 'انتهت الجلسة. يرجى تسجيل الدخول مرة أخرى.',
            SOURCE_INACTIVE: 'حساب المرسل غير نشط.',
            TARGET_INACTIVE: 'الحساب المستلم غير نشط.',
            SAME_ACCOUNT: 'لا يمكن تحويل الرصيد إلى نفس الحساب.',
            INVALID_ACCOUNT_CODE: 'كود المستلم غير صالح.',
            TARGET_NOT_FOUND: 'لم يتم العثور على حساب بهذا الكود.',
            INSUFFICIENT_BALANCE: 'الرصيد غير كافٍ لإتمام العملية.',
            INVALID_AMOUNT: 'المبلغ المدخل غير صالح.',
            IDEMPOTENCY_CONFLICT: 'مفتاح العملية مستخدم لطلب مختلف.',
            LOCK_TIMEOUT: 'الرجاء المحاولة مرة أخرى لاحقاً.'
        };
        if (knownMsg[e.message]) {
            const status = e.message === 'TARGET_NOT_FOUND' ? 404 : (e.message === 'SESSION_EXPIRED' ? 401 : (e.message === 'IDEMPOTENCY_CONFLICT' ? 409 : 400));
            return sendMobileError(res, status, e.message, knownMsg[e.message], req.correlationId);
        }
        return sendServerError(res, req, 'تعذر تنفيذ تحويل الرصيد');
    }
});

// ⚠️ Client Complaint
router.post('/client/complaints', authenticateJWT, complaintValidator, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        const { transactionId, complaintText } = req.body;
        
        const tx = await mobileWebParityService.submitClientComplaint({
            userId,
            accountType,
            transactionId,
            complaintText
        });
        
        return res.json({
            success: true,
            complaint: mobileWebParityMapper.toComplaintDto(tx)
        });
    } catch (e) {
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'غير مصرح لك بتقديم شكوى على هذه العملية', req.correlationId);
        }
        if (e.message === 'INVALID_STATE') {
            return sendMobileError(res, 400, 'INVALID_STATE', 'لا يمكن تقديم شكوى على عملية ملغية أو مرفوضة', req.correlationId);
        }
        if (e.message === 'TRANSACTION_NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'العملية غير موجودة', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء تسجيل الشكوى');
    }
});

// 🤖 Executor Alerts Clearing
router.post('/executor/alerts/:id/clear', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        await mobileWebParityService.clearExecutorAlert({
            executorId: userId,
            taskId: req.params.id,
            alertType: 'emergency'
        });
        return res.json({ success: true });
    } catch (e) {
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'غير مصرح لك بتعديل هذه المهمة', req.correlationId);
        }
        if (e.message === 'TASK_NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'المهمة غير موجودة', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء مسح التنبيه');
    }
});

router.post('/executor/deposit-alerts/:id/clear', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        await mobileWebParityService.clearExecutorAlert({
            executorId: userId,
            taskId: req.params.id,
            alertType: 'deposit'
        });
        return res.json({ success: true });
    } catch (e) {
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'غير مصرح لك بتعديل هذه المهمة', req.correlationId);
        }
        if (e.message === 'TASK_NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'المهمة غير موجودة', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء مسح تنبيه الإيداع');
    }
});

// 📥 Executor Deposit Request (Idempotent)
router.post('/executor/request-deposit', authenticateJWT, requireIdempotencyKey, depositRequestValidator, async (req, res) => {
    try {
        const { userId } = req.user;
        const { amount } = req.body;
        
        const result = await mobileWebParityService.requestExecutorDeposit({
            executorId: userId,
            amount,
            req
        });
        
        return res.json(result.response);
    } catch (e) {
        if (e.message === 'IDEMPOTENCY_CONFLICT') {
            return sendMobileError(res, 409, 'IDEMPOTENCY_CONFLICT', 'مفتاح العملية مستخدم لطلب مختلف', req.correlationId);
        }
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        return sendServerError(res, req, 'تعذر تقديم طلب الإيداع');
    }
});

// 👨‍💻 Executor Edit Amount (Idempotent)
router.post('/executor/tasks/:id/edit-amount', authenticateJWT, requireIdempotencyKey, editAmountValidator, async (req, res) => {
    try {
        const { userId } = req.user;
        const { newAmount, reason } = req.body;
        
        const result = await mobileWebParityService.editTaskAmount({
            executorId: userId,
            taskId: req.params.id,
            newAmount,
            reason,
            req
        });
        
        return res.json(result.response);
    } catch (e) {
        const knownMsg = {
            INVALID_STATE: 'حالة المهمة الحالية لا تسمح بتعديل القيمة.',
            INVALID_AMOUNT: 'المبلغ غير صالح.',
            INSUFFICIENT_BALANCE: 'رصيد العميل غير كافٍ لإتمام التعديل.',
            IDEMPOTENCY_CONFLICT: 'مفتاح العملية مستخدم لطلب تعديل مختلف.',
            UNAUTHORIZED: 'غير مصرح بالوصول.'
        };
        if (knownMsg[e.message]) {
            const status = e.message === 'IDEMPOTENCY_CONFLICT' ? 409 : (e.message === 'UNAUTHORIZED' ? 401 : 400);
            return sendMobileError(res, status, e.message, knownMsg[e.message], req.correlationId);
        }
        return sendServerError(res, req, 'تعذر تعديل قيمة المهمة');
    }
});

// 👨‍💻 Executor Return Task
router.post('/executor/tasks/:id/return', authenticateJWT, returnTaskValidator, async (req, res) => {
    try {
        const { userId } = req.user;
        const { reason } = req.body;
        
        await mobileWebParityService.returnTask({
            executorId: userId,
            taskId: req.params.id,
            reason
        });
        
        return res.json({ success: true, message: 'تم إرجاع المهمة للإدارة بنجاح' });
    } catch (e) {
        if (e.message === 'INVALID_STATE') {
            return sendMobileError(res, 400, 'INVALID_STATE', 'لا يمكن إرجاع هذه المهمة لأنها ليست مقبولة لديك حالياً', req.correlationId);
        }
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        return sendServerError(res, req, 'تعذر إرجاع المهمة');
    }
});

// 👨‍💻 Executor ZaynPay Execution (Idempotent)
router.post('/executor/tasks/:id/zaynpay-execute', authenticateJWT, requireIdempotencyKey, async (req, res) => {
    try {
        const { userId } = req.user;
        
        const result = await mobileWebParityService.executeZaynPayIdempotent({
            executorId: userId,
            taskId: req.params.id,
            req
        });
        
        return res.json(result.response);
    } catch (e) {
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'غير مصرح لك بتشغيل نظام ZaynPay الآلي', req.correlationId);
        }
        if (e.message === 'IDEMPOTENCY_CONFLICT') {
            return sendMobileError(res, 409, 'IDEMPOTENCY_CONFLICT', 'مفتاح العملية مستخدم لطلب ZaynPay مختلف', req.correlationId);
        }
        if (e.message === 'TASK_NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'المهمة غير موجودة', req.correlationId);
        }
        if (e.message === 'INVALID_STATE') {
            return sendMobileError(res, 400, 'INVALID_STATE', 'المهمة مكتملة بالفعل ولا يمكن إعادة تنفيذها', req.correlationId);
        }
        if (e.message === 'INVALID_AMOUNT' || e.message === 'INVALID_WALLET') {
            return sendMobileError(res, 400, e.message, 'بيانات العملية غير صالحة للتنفيذ الآلي', req.correlationId);
        }
        if (e.message === 'INSUFFICIENT_EXECUTOR_BALANCE') {
            return sendMobileError(res, 409, 'INSUFFICIENT_EXECUTOR_BALANCE', 'رصيد مجموعة المنفذ غير كافٍ لتنفيذ العملية', req.correlationId);
        }
        if (e.message === 'LOCK_TIMEOUT') {
            return sendMobileError(res, 409, 'LOCK_TIMEOUT', 'تعذر قفل العملية حالياً، يرجى المحاولة لاحقاً', req.correlationId);
        }
        return sendMobileError(res, 400, 'PAYMENT_FAILED', e.message, req.correlationId);
    }
});

// 👨‍💻 Executor Support Messages
router.get('/executor/tickets/current', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        const ticket = await mobileWebParityService.getExecutorSupportTicket({ executorId: userId });
        return res.json({
            success: true,
            ticket: mobileWebParityMapper.toExecutorSupportTicketDto(ticket)
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء جلب تذكرة الدعم الفني');
    }
});

router.post('/executor/tickets/messages', authenticateJWT, executorSupportMessageValidator, async (req, res) => {
    try {
        const { userId } = req.user;
        const { text, imageBase64 } = req.body;
        
        if (!text && !imageBase64) {
            return sendMobileError(res, 400, 'VALIDATION_ERROR', 'يجب إرسال نص أو صورة', req.correlationId);
        }
        
        const message = await mobileWebParityService.sendExecutorSupportReply({
            executorId: userId,
            text,
            imageBase64
        });
        
        return res.json({
            success: true,
            message: {
                sender: message.sender,
                text: message.text,
                imageUrl: message.imageUrl || null,
                createdAt: message.createdAt.toISOString()
            }
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        if (e.message === 'INVALID_IMAGE' || e.message === 'IMAGE_TOO_LARGE') {
            return sendMobileError(res, 400, e.message, 'الصورة المرفقة غير صالحة أو حجمها أكبر من المسموح', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء إرسال الرسالة للدعم الفني');
    }
});

// 📊 Executor Reports
router.post('/executor/reports/filter', authenticateJWT, executorReportsValidator, async (req, res) => {
    try {
        const { userId } = req.user;
        const { dateType, dateValue } = req.body;
        
        const result = await mobileWebParityService.getExecutorReports({
            executorId: userId,
            dateType,
            dateValue
        });
        
        return res.json({
            success: true,
            data: mobileWebParityMapper.toClientReportDto(result),
            serverTime: new Date().toISOString()
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء جلب التقارير');
    }
});

// 👥 Executor Employee Management (Manager only)
router.get('/executor/employees', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        const list = await mobileWebParityService.getEmployeesList(userId);
        return res.json({
            success: true,
            employees: list.map(emp => mobileWebParityMapper.toEmployeeDto(emp))
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'ليس لديك صلاحيات مدير لتصفح الموظفين', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء جلب قائمة الموظفين');
    }
});

router.post('/executor/employees', authenticateJWT, createEmployeeValidator, async (req, res) => {
    try {
        const { userId } = req.user;
        const { name, phone, role, webUsername, webPassword } = req.body;
        const tenantId = req.tenant ? req.tenant._id : null;
        
        const created = await mobileWebParityService.createEmployee({
            executorId: userId,
            name,
            phone,
            role,
            webUsername,
            webPassword,
            tenantId
        });
        
        return res.json({
            success: true,
            employee: mobileWebParityMapper.toEmployeeDto(created)
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'ليس لديك صلاحيات مدير لإضافة موظف', req.correlationId);
        }
        if (e.message === 'INVALID_ROLE') {
            return sendMobileError(res, 400, 'INVALID_ROLE', 'الدور الوظيفي المحدد غير صالح', req.correlationId);
        }
        if (e.message === 'INVALID_USERNAME') {
            return sendMobileError(res, 400, 'INVALID_USERNAME', 'اسم المستخدم يجب أن يحتوي على أحرف وأرقام إنجليزية فقط', req.correlationId);
        }
        if (e.message === 'USERNAME_TAKEN') {
            return sendMobileError(res, 400, 'USERNAME_TAKEN', 'اسم المستخدم مسجل بالفعل في النظام', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء إضافة الموظف');
    }
});

router.patch('/executor/employees/:id/status', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        const updated = await mobileWebParityService.toggleEmployeeStatus({
            executorId: userId,
            targetId: req.params.id
        });
        return res.json({
            success: true,
            employee: mobileWebParityMapper.toEmployeeDto(updated)
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'ليس لديك صلاحيات مدير لتعديل حالة الموظف', req.correlationId);
        }
        if (e.message === 'NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الموظف غير موجود أو لا ينتمي إلى مجموعتك', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء تعديل حالة الموظف');
    }
});

router.patch('/executor/employees/:id/reports-permission', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        const updated = await mobileWebParityService.toggleEmployeeReports({
            executorId: userId,
            targetId: req.params.id
        });
        return res.json({
            success: true,
            employee: mobileWebParityMapper.toEmployeeDto(updated)
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'ليس لديك صلاحيات مدير لتعديل صلاحيات التقارير للموظف', req.correlationId);
        }
        if (e.message === 'NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الموظف غير موجود أو لا ينتمي إلى مجموعتك', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء تعديل صلاحيات التقارير للموظف');
    }
});

router.post('/executor/employees/:id/reset-password', authenticateJWT, resetPasswordValidator, async (req, res) => {
    try {
        const { userId } = req.user;
        const { newPassword } = req.body;
        
        await mobileWebParityService.resetEmployeePassword({
            executorId: userId,
            targetId: req.params.id,
            newPassword
        });
        
        return res.json({
            success: true,
            message: 'تم إعادة تعيين كلمة المرور بنجاح'
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'ليس لديك صلاحيات مدير لإعادة تعيين كلمة المرور للموظف', req.correlationId);
        }
        if (e.message === 'NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الموظف غير موجود أو لا ينتمي إلى مجموعتك', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء إعادة تعيين كلمة المرور');
    }
});

router.delete('/executor/employees/:id', authenticateJWT, async (req, res) => {
    try {
        const { userId } = req.user;
        await mobileWebParityService.deleteEmployee({
            executorId: userId,
            targetId: req.params.id
        });
        return res.json({
            success: true,
            message: 'تم حذف الموظف بنجاح'
        });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'ليس لديك صلاحيات مدير لحذف الموظف', req.correlationId);
        }
        if (e.message === 'NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الموظف غير موجود أو لا ينتمي إلى مجموعتك', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء حذف الموظف');
    }
});

router.use((req, res) => {
    return sendMobileError(res, 404, 'NOT_FOUND', 'المورد غير موجود', req.correlationId);
});

router.use(mobileErrorHandler);

module.exports = router;
