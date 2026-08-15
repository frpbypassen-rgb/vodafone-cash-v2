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
const AuditLog = require('../models/AuditLog');
const MobileDeviceSession = require('../models/MobileDeviceSession');

const { authenticateJWT } = require('../middlewares/jwtAuth');
const correlationId = require('../middlewares/correlationId');
const requireIdempotencyKey = require('../middlewares/requireIdempotencyKey');
const { logAction } = require('../services/auditService');
const { verifyAndUpgradePassword } = require('../utils/helpers');
const { proofSourceUrl, saveProofImage, streamProofImage } = require('../services/proofStorageService');
const { saveProfilePhoto, streamProfilePhoto, removeProfilePhoto } = require('../services/profilePhotoStorageService');
const authController = require('../controllers/auth/authController');
const transferService = require('../services/transferService');
const { deviceTrustMiddleware } = require('../src/Presentation/Middlewares/deviceTrustMiddleware');
const { mfaMiddleware } = require('../src/Presentation/Middlewares/mfaMiddleware');
const { buildMobileRateContract, buildCompanyRateContract } = require('../utils/rateHelper');
const { applyCustomerRateMargins } = require('../utils/agencyPricing');
const { getTransferServiceLabel } = require('../utils/mobileTransferServiceCatalog');
const { calculateCreditState } = require('../services/agencyCreditLimitService');
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
    updateExecutorEmployeeProfileValidator,
    resetPasswordValidator,
    executorReportsValidator,
    executorSupportMessageValidator,
    customerProfilePhotoValidator,
    customerProfileValidator,
    customerPasswordValidator
} = require('../validators/mobileValidators');

const mobileWebParityService = require('../services/mobileWebParityService');
const mobileWebParityMapper = require('../mappers/mobileWebParityMapper');
const { resolveClientNotificationUserIds } = require('../services/clientNotificationService');
const { setPortalSupportReplyChannel } = require('../services/whatChimpSupportService');
const {
    directRegisterValidator,
    newRegisterValidator,
    companyRegisterValidator,
    agentRegisterValidator
} = require('../validators/mobileRegistrationValidators');
const { sendMobileError, mobileErrorHandler } = require('../mappers/mobileErrorMapper');
const { checkRegistrationIdentityAvailability } = require('../services/registrationIdentityService');
const { customerNoteFromTransaction } = require('../utils/transactionNotes');
const {
    ManualExecutionNumberError,
    maskManualExecutionNumber,
    generateManualExecutorReceiptBase64
} = require('../utils/manualExecutorReceipt');
const { reserveManualExecutorReceiptReference } = require('../services/manualExecutorReceiptReferenceService');
const { reversalService } = require('../src/Application/Services/ReversalService');
const { executorTransferRequiresProof } = require('../utils/executorServiceCatalog');
const eventBus = require('../services/eventBus');
const {
    acceptExecutorTask,
    taskOwnershipFilter,
    listRouteCandidates,
    routeExecutorTask,
    routingErrorMessage
} = require('../services/executorTaskRoutingService');
const {
    findBrowserExecutable,
    getSharedBrowser,
    logoDataUri,
    renderView
} = require('../services/reportPdfService');

const router = express.Router();

const REPORT_DOWNLOAD_TTL_MS = 2 * 60 * 1000;

const reportDownloadSecret = () => (
    process.env.MOBILE_REPORT_DOWNLOAD_SECRET || process.env.JWT_SECRET || ''
);

const createReportDownloadToken = (payload) => {
    const secret = reportDownloadSecret();
    if (!secret) {
        const error = new Error('REPORT_DOWNLOAD_NOT_CONFIGURED');
        error.code = 'REPORT_DOWNLOAD_NOT_CONFIGURED';
        throw error;
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
};

const readReportDownloadToken = (token) => {
    const [encoded, signature] = String(token || '').split('.');
    const secret = reportDownloadSecret();
    if (!encoded || !signature || !secret) throw new Error('INVALID_REPORT_DOWNLOAD_TOKEN');

    const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    const receivedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
        receivedBuffer.length !== expectedBuffer.length
        || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
        throw new Error('INVALID_REPORT_DOWNLOAD_TOKEN');
    }

    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if ((!payload.executorId && !payload.clientId) || !payload.expiresAt || Date.now() > Number(payload.expiresAt)) {
            throw new Error('INVALID_REPORT_DOWNLOAD_TOKEN');
        }
        return payload;
    } catch (_) {
        throw new Error('INVALID_REPORT_DOWNLOAD_TOKEN');
    }
};

const generateExecutorReportPdf = async (app, data) => {
    const executablePath = findBrowserExecutable();
    if (!executablePath) {
        const error = new Error('PDF_BROWSER_NOT_FOUND');
        error.code = 'PDF_BROWSER_NOT_FOUND';
        throw error;
    }

    const html = await renderView(app, 'executor_report_pdf', {
        ...data,
        logoDataUri: logoDataUri()
    });
    let page;
    try {
        const browser = await getSharedBrowser(executablePath);
        page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
        await page.emulateMediaType('print');
        return Buffer.from(await page.pdf({
            format: 'A4',
            landscape: true,
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '11mm', right: '9mm', bottom: '13mm', left: '9mm' },
            displayHeaderFooter: false
        }));
    } finally {
        if (page) await page.close().catch(() => {});
    }
};

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

const toExecutorTaskDto = (tx, currentExecutorId = null) => ({
    id: tx._id ? String(tx._id) : null,
    txId: tx.customId || null,
    transferType: tx.transferType || null,
    transferTypeLabel: getTransferServiceLabel(tx.transferType),
    amount: Number(tx.amount || 0),
    recipientNumber: tx.serviceDetails?.recipientPhone || tx.vodafoneNumber || tx.accountNumber || null,
    recipientName: tx.accountName || null,
    nationalId: tx.nationalId || null,
    governorate: tx.governorate || tx.serviceDetails?.governorate || null,
    notes: customerFacingNotes(customerNoteFromTransaction(tx)) || null,
    status: tx.status || 'unknown',
    operatorId: tx.operatorId ? String(tx.operatorId) : null,
    assignedExecutorId: tx.assignedExecutorId ? String(tx.assignedExecutorId) : null,
    assignedExecutorName: tx.assignedExecutorName || null,
    isAssignedToCurrentExecutor: Boolean(
        currentExecutorId &&
        tx.assignedExecutorId &&
        String(tx.assignedExecutorId) === String(currentExecutorId)
    ),
    acceptedByName: tx.status === 'accepted' ? (tx.executorName || null) : null,
    isOwnedByCurrentExecutor: Boolean(
        currentExecutorId &&
        tx.status === 'accepted' &&
        tx.operatorId &&
        String(tx.operatorId) === String(currentExecutorId)
    ),
    executorReceivedAt: tx.executorReceivedAt
        ? new Date(tx.executorReceivedAt).toISOString()
        : (tx.createdAt ? new Date(tx.createdAt).toISOString() : null),
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
    let profileAccount = null;

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
            user = await User.findOne({ _id: userId, tenantId: { $in: [req.tenant._id, null] } });
        } else {
            user = await User.findById(userId);
        }
        if (user) {
            profileAccount = user;
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
            profileAccount = subAccount;
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
        const subServiceRates = applyCustomerRateMargins(masterContract.serviceRates, subAccount);
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

    if (['client_user', 'sub_client'].includes(accountType) && profileAccount) {
        if (accountType === 'sub_client' && !masterForRates) {
            if (subAccount.masterType === 'user') {
                masterForRates = await User.findById(subAccount.masterId);
            } else {
                masterForRates = await ClientCompany.findById(subAccount.masterId);
            }
        }
        const { buildContext } = require('../mappers/mobileAuthMapper');
        if (accountType === 'sub_client') {
            const creditState = calculateCreditState({ balance, creditLimit: subAccount.creditLimit });
            Object.assign(responseData, creditState, { minimumAllowedBalance: creditState.minimumBalance });
        }
        responseData.context = buildContext(accountType, {
            masterName: accountType === 'sub_client' && masterForRates ? masterForRates.name : null,
            agentId: accountType === 'sub_client' && subAccount.masterType === 'user' ? subAccount.masterId : null,
            agentName: accountType === 'sub_client' && subAccount.masterType === 'user' && masterForRates ? masterForRates.name : null,
            agentCode: accountType === 'sub_client' && subAccount.masterType === 'user' && masterForRates
                ? (masterForRates.agentCode || masterForRates.accountCode || null)
                : null,
            accountCode: profileAccount.accountCode || '',
            username: profileAccount.webUsername || '',
            phone: profileAccount.phone || '',
            address: profileAccount.address
                || (profileAccount.businessProfile && (profileAccount.businessProfile.address || profileAccount.businessProfile.city))
                || '',
            joinedAt: profileAccount.createdAt || null,
            profilePhotoUpdatedAt: profileAccount.profilePhotoUpdatedAt || null,
            status: profileAccount.status || 'active'
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
        const { executorGroupId, accountType, userId } = req.user;
        if (accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        const employeeQuery = { _id: userId };
        if (req.tenant) employeeQuery.tenantId = req.tenant._id;
        const employeeLookup = Employee.findOne(employeeQuery);
        const employee = typeof employeeLookup?.populate === 'function'
            ? await employeeLookup.populate('groupId')
            : await employeeLookup;
        if (!employee) {
            return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        }
        if (employee.role === 'accountant') {
            return sendMobileError(res, 403, 'TASKS_FORBIDDEN', 'صلاحيات المحاسب لا تسمح بتنفيذ العمليات', req.correlationId);
        }
        const groupId = employee.groupId || executorGroupId;

        const queryTasks = {
            ...taskOwnershipFilter(employee),
            status: { $in: ['processing', 'accepted'] }
        };
        if (req.tenant) queryTasks.tenantId = req.tenant._id;
        const tasks = await Transaction.find(queryTasks).sort({ createdAt: 1 }).lean();

        const queryAlerts = {
            ...taskOwnershipFilter(employee),
            emergencyAlert: { $exists: true, $ne: null },
            status: { $in: ['processing', 'accepted'] }
        };
        if (req.tenant) queryAlerts.tenantId = req.tenant._id;
        const alerts = await Transaction.find(queryAlerts).lean();

        return res.json({
            success: true,
            data: tasks.map((task) => toExecutorTaskDto(task, userId)),
            alerts: alerts.map((task) => toExecutorTaskDto(task, userId)),
            manualTaskRoutingEnabled: Boolean(employee.groupId?.manualTaskRoutingEnabled),
            canRouteTasks: employee.role === 'manager',
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

        if (emp.role === 'accountant') {
            return sendMobileError(res, 403, 'TASKS_FORBIDDEN', 'صلاحيات المحاسب لا تسمح بتنفيذ العمليات', req.correlationId);
        }

        const groupId = emp.groupId && (emp.groupId._id || emp.groupId);
        if (!groupId) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'Ø§Ù„Ù…Ù†ÙØ° ØºÙŠØ± Ù…Ø±Ø¨ÙˆØ· Ø¨Ù…Ø¬Ù…ÙˆØ¹Ø© ØµØ§Ù„Ø­Ø©', req.correlationId);
        }

        const acceptance = await acceptExecutorTask({
            transactionId: req.params.id,
            executor: emp,
            tenantId: req.tenant?._id || null
        });
        if (!acceptance.ok) {
            const status = acceptance.code === 'ACTIVE_TASK_EXISTS' || acceptance.code === 'TASK_UNAVAILABLE' ? 409 : 400;
            return sendMobileError(res, status, acceptance.code, routingErrorMessage(acceptance.code), req.correlationId);
        }
        return res.json({ success: true });

    } catch (e) {
        return sendServerError(res, req);
    }
});

router.post('/executor/task-routing-mode', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        const employeeQuery = { _id: req.user.userId, role: 'manager' };
        if (req.tenant) employeeQuery.tenantId = req.tenant._id;
        const employee = await Employee.findOne(employeeQuery).populate('groupId');
        if (!employee?.groupId) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه العملية متاحة لمدير التنفيذ فقط.', req.correlationId);
        }
        const group = await ExecutorGroup.findByIdAndUpdate(
            employee.groupId._id || employee.groupId,
            { $set: { manualTaskRoutingEnabled: Boolean(req.body?.enabled) } },
            { new: true }
        );
        return res.json({ success: true, manualTaskRoutingEnabled: Boolean(group?.manualTaskRoutingEnabled) });
    } catch (error) {
        return sendServerError(res, req);
    }
});

router.get('/executor/route-candidates', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        const employeeQuery = { _id: req.user.userId, role: 'manager' };
        if (req.tenant) employeeQuery.tenantId = req.tenant._id;
        const manager = await Employee.findOne(employeeQuery).populate('groupId');
        if (!manager?.groupId) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه العملية متاحة لمدير التنفيذ فقط.', req.correlationId);
        }
        const employees = await listRouteCandidates({
            groupId: manager.groupId._id || manager.groupId,
            tenantId: req.tenant?._id || null
        });
        return res.json({ success: true, data: employees });
    } catch (error) {
        return sendServerError(res, req);
    }
});

router.post('/executor/route-task/:id', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        const employeeQuery = { _id: req.user.userId, role: 'manager' };
        if (req.tenant) employeeQuery.tenantId = req.tenant._id;
        const manager = await Employee.findOne(employeeQuery).populate('groupId');
        const result = await routeExecutorTask({
            transactionId: req.params.id,
            manager,
            employeeId: req.body?.employeeId,
            tenantId: req.tenant?._id || null
        });
        if (!result.ok) {
            const status = result.code === 'ACTIVE_TASK_EXISTS' || result.code === 'TASK_UNAVAILABLE' ? 409 : 400;
            return sendMobileError(res, status, result.code, routingErrorMessage(result.code), req.correlationId);
        }
        return res.json({ success: true, employee: { id: String(result.employee._id), name: result.employee.name } });
    } catch (error) {
        return sendServerError(res, req);
    }
});

const resolveCustomerProfileAccount = async (req) => {
    const { userId, accountType } = req.user;
    if (accountType === 'client_user') {
        const filter = { _id: userId };
        if (req.tenant) filter.tenantId = { $in: [req.tenant._id, null] };
        return { Model: User, account: await User.findOne(filter) };
    }
    if (accountType === 'sub_client') {
        return { Model: SubAccount, account: await SubAccount.findById(userId) };
    }
    return { Model: null, account: null };
};

const customerProfilePayload = (account) => ({
    name: account.name || '',
    username: account.webUsername || '',
    phone: account.phone || '',
    address: account.address
        || (account.businessProfile && (account.businessProfile.address || account.businessProfile.city))
        || '',
    status: account.status || 'active',
    joinedAt: account.createdAt ? new Date(account.createdAt).toISOString() : null,
    photoUpdatedAt: account.profilePhotoUpdatedAt
        ? new Date(account.profilePhotoUpdatedAt).toISOString()
        : null
});

router.get('/client/profile-photo', authenticateJWT, async (req, res) => {
    try {
        const { account } = await resolveCustomerProfileAccount(req);
        if (!account || !account.profilePhotoKey) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'لا توجد صورة شخصية للحساب', req.correlationId);
        }
        return streamProfilePhoto(account.profilePhotoKey, res);
    } catch (error) {
        return sendMobileError(res, error.code === 'NOT_FOUND' ? 404 : 500, error.code || 'SERVER_ERROR', 'تعذر تحميل الصورة الشخصية', req.correlationId);
    }
});

router.put('/client/profile-photo', authenticateJWT, customerProfilePhotoValidator, async (req, res) => {
    let newPhotoKey = null;
    try {
        const { Model, account } = await resolveCustomerProfileAccount(req);
        if (!Model || !account) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'تغيير الصورة متاح لحسابات العملاء فقط', req.correlationId);
        }

        newPhotoKey = saveProfilePhoto(req.body.imageBase64, account._id);
        const updatedAt = new Date();
        await Model.updateOne(
            { _id: account._id },
            { $set: { profilePhotoKey: newPhotoKey, profilePhotoUpdatedAt: updatedAt } }
        );
        if (account.profilePhotoKey && account.profilePhotoKey !== newPhotoKey) {
            try { removeProfilePhoto(account.profilePhotoKey); } catch (_) { /* cleanup is best effort */ }
        }
        await logAction({
            action: 'CUSTOMER_PROFILE_PHOTO_UPDATED',
            req,
            performedById: account._id,
            performedByModel: req.user.accountType === 'sub_client' ? 'SubAccount' : 'User',
            performedByName: account.name || account.webUsername,
            metadata: { accountType: req.user.accountType }
        });
        return res.json({
            success: true,
            profile: { photoUpdatedAt: updatedAt.toISOString() }
        });
    } catch (error) {
        if (newPhotoKey) {
            try { removeProfilePhoto(newPhotoKey); } catch (_) { /* cleanup is best effort */ }
        }
        return sendMobileError(res, error.code === 'MALFORMED_IMAGE' ? 400 : 500, error.code || 'SERVER_ERROR', 'تعذر حفظ الصورة الشخصية', req.correlationId);
    }
});

router.patch('/client/profile', authenticateJWT, customerProfileValidator, async (req, res) => {
    try {
        const { Model, account } = await resolveCustomerProfileAccount(req);
        if (!Model || !account) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'تعديل البيانات متاح لحسابات العملاء فقط', req.correlationId);
        }

        const name = req.body.name.trim();
        const address = (req.body.address || '').trim();
        const update = req.user.accountType === 'sub_client'
            ? { name, address }
            : { name, 'businessProfile.address': address };
        const updated = await Model.findByIdAndUpdate(
            account._id,
            { $set: update },
            { new: true, runValidators: true }
        );
        await logAction({
            action: 'CUSTOMER_PROFILE_UPDATED',
            req,
            performedById: account._id,
            performedByModel: req.user.accountType === 'sub_client' ? 'SubAccount' : 'User',
            performedByName: name,
            oldData: { name: account.name, address: customerProfilePayload(account).address },
            newData: { name, address }
        });
        return res.json({ success: true, profile: customerProfilePayload(updated) });
    } catch (_) {
        return sendServerError(res, req, 'تعذر تحديث بيانات الحساب');
    }
});

router.get('/client/security/devices', authenticateJWT, async (req, res) => {
    try {
        const { account } = await resolveCustomerProfileAccount(req);
        if (!account) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الصفحة متاحة لحسابات العملاء فقط', req.correlationId);
        }
        const sessions = await MobileDeviceSession.find({
            accountId: account._id,
            accountType: req.user.accountType,
            active: true
        })
            .sort({ createdAt: -1 })
            .limit(20)
            .select('sessionId deviceType userAgent deviceFingerprint createdAt lastSeenAt')
            .lean();
        const devices = sessions.map((item) => ({
            sessionId: item.sessionId,
            deviceType: item.deviceType || 'هاتف',
            userAgent: item.userAgent || 'جهاز غير معروف',
            lastSeenAt: item.lastSeenAt || item.createdAt,
            current: item.sessionId === req.user.sessionId
        }));
        return res.json({ success: true, devices });
    } catch (_) {
        return sendServerError(res, req, 'تعذر تحميل الأجهزة المسجل منها الدخول');
    }
});

router.post('/client/security/change-password', authenticateJWT, customerPasswordValidator, async (req, res) => {
    try {
        const { account } = await resolveCustomerProfileAccount(req);
        if (!account) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'تغيير كلمة المرور متاح لحسابات العملاء فقط', req.correlationId);
        }
        const Model = req.user.accountType === 'sub_client' ? SubAccount : User;
        const valid = await verifyAndUpgradePassword(
            req.body.currentPassword,
            account.webPassword,
            Model,
            account._id
        );
        if (!valid) {
            return sendMobileError(res, 400, 'INVALID_PASSWORD', 'كلمة المرور الحالية غير صحيحة', req.correlationId);
        }
        account.webPassword = req.body.newPassword;
        account.refreshToken = undefined;
        account.sessionVersion = Number(account.sessionVersion || 0) + 1;
        await account.save();
        await MobileDeviceSession.updateMany(
            { accountId: account._id, accountType: req.user.accountType, active: true },
            { $set: { active: false, lastSeenAt: new Date() } }
        );
        await logAction({
            action: 'CUSTOMER_PASSWORD_CHANGED',
            req,
            performedById: account._id,
            performedByModel: req.user.accountType === 'sub_client' ? 'SubAccount' : 'User',
            performedByName: account.name || account.webUsername
        });
        return res.json({ success: true, message: 'تم تغيير كلمة المرور وإبطال جميع الجلسات.' });
    } catch (_) {
        return sendServerError(res, req, 'تعذر تغيير كلمة المرور');
    }
});

router.post('/client/security/logout-all', authenticateJWT, async (req, res) => {
    try {
        const { Model, account } = await resolveCustomerProfileAccount(req);
        if (!Model || !account) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه العملية متاحة لحسابات العملاء فقط', req.correlationId);
        }
        if (req.user.sessionId) {
            await MobileDeviceSession.updateMany(
                {
                    accountId: account._id,
                    accountType: req.user.accountType,
                    sessionId: { $ne: req.user.sessionId },
                    active: true
                },
                { $set: { active: false, lastSeenAt: new Date() } }
            );
        } else {
            await Model.updateOne(
                { _id: account._id },
                { $inc: { sessionVersion: 1 }, $unset: { refreshToken: 1 } }
            );
        }
        await logAction({
            action: 'CUSTOMER_LOGOUT_ALL_DEVICES',
            req,
            performedById: account._id,
            performedByModel: req.user.accountType === 'sub_client' ? 'SubAccount' : 'User',
            performedByName: account.name || account.webUsername
        });
        return res.json({ success: true, message: 'تم تسجيل الخروج من جميع الأجهزة.' });
    } catch (_) {
        return sendServerError(res, req, 'تعذر إنهاء جلسات الأجهزة');
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
    try {
        const { reason } = req.body;
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') throw new Error('FORBIDDEN');

        const empQuery = { _id: userId };
        if (req.tenant) empQuery.tenantId = req.tenant._id;
        const emp = await Employee.findOne(empQuery);
        if (!emp) throw new Error('EMPLOYEE_NOT_FOUND');
        if (emp.role === 'accountant') throw new Error('TASKS_FORBIDDEN');

        const txQuery = {
            _id: req.params.id,
            status: 'accepted',
            operatorId: emp._id.toString()
        };
        if (req.tenant) txQuery.tenantId = req.tenant._id;
        const tx = await Transaction.findOne(txQuery);
        if (!tx) throw new Error('INVALID_STATE');

        // Use the same reversal service as the administration panel. It records the
        // cancellation number, refunds all supported account types, and creates the receipt.
        const result = await reversalService.reverseTransaction(
            tx._id.toString(),
            reason,
            emp.name || 'المنفذ',
            { status: 'rejected' }
        );
        if (!result.success) {
            return sendMobileError(res, 409, 'CANCELLATION_FAILED', result.message, req.correlationId);
        }

        await logAction({
            action: 'TRANSFER_CANCELLED',
            req,
            performedById: emp._id,
            performedByModel: 'Employee',
            performedByName: emp.name,
            targetId: tx._id,
            targetModel: 'Transaction',
            oldData: { status: 'accepted', costLYD: tx.costLYD },
            newData: { status: 'rejected', reason, cancellationNumber: result.cancellationNumber },
            metadata: {
                customId: tx.customId,
                refundAmount: tx.costLYD,
                cancellationNumber: result.cancellationNumber
            }
        });

        return res.json({
            success: true,
            message: result.message,
            cancellationNumber: result.cancellationNumber
        });
    } catch (e) {
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        if (e.message === 'TASKS_FORBIDDEN') {
            return sendMobileError(res, 403, 'TASKS_FORBIDDEN', 'صلاحيات المحاسب لا تسمح بتنفيذ العمليات', req.correlationId);
        }
        if (e.message === 'EMPLOYEE_NOT_FOUND') {
            return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        }
        if (e.message === 'INVALID_STATE') {
            return sendMobileError(res, 409, 'INVALID_STATE', 'لا يمكن إلغاء هذه العملية الآن', req.correlationId);
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
 *             properties:
 *               imageBase64:
 *                 type: string
 *                 description: صورة الإثبات بصيغة Base64. إلزامية لعمليات سيفا النيجر فقط.
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
        const { imageBase64, executionNumber: requestedExecutionNumber, senderPhone } = req.body;
        const executionNumber = String(requestedExecutionNumber ?? senderPhone ?? '').trim();
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        let maskedExecutionNumber = '';
        try {
            maskedExecutionNumber = maskManualExecutionNumber(executionNumber);
        } catch (error) {
            if (error instanceof ManualExecutionNumberError) {
                return sendMobileError(res, 400, error.code, error.message, req.correlationId);
            }
            throw error;
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
        if (emp.role === 'accountant') {
            return sendMobileError(res, 403, 'TASKS_FORBIDDEN', 'صلاحيات المحاسب لا تسمح بتنفيذ العمليات', req.correlationId);
        }

        if (!tx || tx.status !== 'accepted' || tx.operatorId !== emp._id.toString()) {
            return sendMobileError(res, 409, 'INVALID_STATE', 'الطلب غير متاح للإنهاء', req.correlationId);
        }
        const proofRequired = executorTransferRequiresProof(tx.transferType);
        if (proofRequired && !imageBase64) {
            return sendMobileError(res, 400, 'SEFA_PROOF_REQUIRED', 'إرفاق صورة إثبات إلزامي لعمليات سيفا النيجر', req.correlationId);
        }

        const executorReceipt = await reserveManualExecutorReceiptReference({ group: emp.groupId });
        const completedAt = new Date();
        const receiptBase64 = await generateManualExecutorReceiptBase64({
            amount: tx.amount,
            customerPhone: tx.vodafoneNumber || tx.accountNumber || tx.serviceDetails?.clientPhone || '---',
            executionNumber: maskedExecutionNumber,
            customId: tx.customId || tx._id.toString(),
            executorReference: executorReceipt.reference,
            serviceName: tx.transferType === 'sefa_niger' ? 'سيفا النيجر' : 'محافظ كاش',
            amountCurrencyLabel: tx.transferType === 'sefa_niger' ? 'سيفا' : 'ج.م',
            transferType: tx.transferType,
            completedAt
        });
        const systemReceiptId = saveProofImage(receiptBase64, `${tx.customId || tx._id}_manual`);

        if (emp.groupId && emp.groupId.parentGroupId) {
            await ExecutorGroup.findByIdAndUpdate(emp.groupId.parentGroupId, { $inc: { balance: -tx.amount } });
        }
        if (emp.groupId) {
            await ExecutorGroup.findByIdAndUpdate(emp.groupId._id, { $inc: { balance: -tx.amount } });
        }

        const savedFileId = imageBase64
            ? saveProofImage(imageBase64, `${tx.customId || tx._id}_executor`)
            : null;

        tx.status = 'completed';
        tx.proofImages = proofRequired
            ? [savedFileId, systemReceiptId].filter(Boolean)
            : [systemReceiptId, savedFileId].filter(Boolean);
        tx.proofImage = tx.proofImages[0];
        tx.executorSenderPhone = executionNumber || undefined;
        tx.executorExecutionNumberMasked = maskedExecutionNumber || undefined;
        tx.manualExecutorReceiptReference = executorReceipt.reference;
        tx.completedAt = completedAt;
        tx.adminNotes = appendAdminNoteText(tx.adminNotes, `[تم توليد إيصال تنفيذ يدوي | مرجع المنفذ: ${executorReceipt.reference}]`);
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
            newData: {
                status: 'completed',
                hasProofImage: true,
                proofRequired,
                manualExecutorReceiptReference: executorReceipt.reference,
                executorExecutionNumberMasked: maskedExecutionNumber || null
            },
            metadata: { customId: tx.customId, amount: tx.amount, transferType: tx.transferType }
        });

        // Publish after persistence. The shared listener sends the WhatsApp receipt with
        // idempotency protection, exactly like the web and API executor channels.
        eventBus.publish('transfer:completed', { tx, emp });

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
            channel: 'portal',
            direction: 'inbound',
            createdAt: new Date()
        };

        ticket.messages.push(newMessage);
        setPortalSupportReplyChannel(ticket);
        ticket.status = 'open';
        ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1;
        await ticket.save();
        req.app.get('io')?.emit('support:ticket-updated', {
            ticketId: String(ticket._id),
            channel: ticket.channel || 'portal',
            direction: 'inbound',
            status: ticket.status
        });

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

        const filters = [query];
        const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || ''))
            ? new Date(`${req.query.dateFrom}T00:00:00`)
            : null;
        const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || ''))
            ? new Date(`${req.query.dateTo}T23:59:59.999`)
            : null;
        if (dateFrom || dateTo) {
            filters.push({
                createdAt: {
                    ...(dateFrom ? { $gte: dateFrom } : {}),
                    ...(dateTo ? { $lte: dateTo } : {})
                }
            });
        }
        const search = String(req.query.search || '').trim().slice(0, 32);
        if (search) {
            const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filters.push({
                $or: [
                    { vodafoneNumber: { $regex: escaped, $options: 'i' } },
                    { accountNumber: { $regex: escaped, $options: 'i' } },
                    { customId: { $regex: `${escaped}$`, $options: 'i' } }
                ]
            });
        }
        if (filters.length > 1) query = { $and: filters };

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
        const { dateType, dateValue, dateFrom, dateTo } = req.body;
        const tenantId = req.tenant ? req.tenant._id : null;
        
        const result = await mobileWebParityService.getClientReports({
            userId,
            accountType,
            dateType,
            dateValue,
            dateFrom,
            dateTo,
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

router.post('/client/reports/download-link', authenticateJWT, clientReportsValidator, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        const { dateType, dateValue, dateFrom, dateTo } = req.body;
        await mobileWebParityService.getClientReports({
            userId,
            accountType,
            dateType,
            dateValue,
            dateFrom,
            dateTo,
            tenantId: req.tenant ? req.tenant._id : null
        });

        const token = createReportDownloadToken({
            clientId: String(userId),
            accountType: String(accountType),
            dateType: String(dateType || 'month'),
            dateValue: dateValue ? String(dateValue) : null,
            dateFrom: dateFrom ? String(dateFrom) : null,
            dateTo: dateTo ? String(dateTo) : null,
            tenantId: req.tenant ? String(req.tenant._id) : null,
            expiresAt: Date.now() + REPORT_DOWNLOAD_TTL_MS
        });
        const configuredBaseUrl = String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
        const baseUrl = configuredBaseUrl || `${req.protocol}://${req.get('host')}`;
        return res.json({
            success: true,
            downloadUrl: `${baseUrl}/api/mobile/client/reports/download.pdf?token=${encodeURIComponent(token)}`
        });
    } catch (e) {
        if (e.code === 'REPORT_DOWNLOAD_NOT_CONFIGURED') {
            return sendMobileError(res, 503, 'REPORT_DOWNLOAD_NOT_CONFIGURED', 'إعداد تنزيل التقارير غير مكتمل على الخادم', req.correlationId);
        }
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح لك بتنزيل هذا التقرير', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء تجهيز تقرير العميل');
    }
});

router.get('/client/reports/download.pdf', async (req, res) => {
    try {
        const payload = readReportDownloadToken(req.query.token);
        if (!payload.clientId) throw new Error('INVALID_REPORT_DOWNLOAD_TOKEN');
        const report = await mobileWebParityService.getClientReports({
            userId: payload.clientId,
            accountType: payload.accountType,
            dateType: payload.dateType,
            dateValue: payload.dateValue,
            dateFrom: payload.dateFrom,
            dateTo: payload.dateTo,
            tenantId: payload.tenantId || null
        });
        const pdf = await generateExecutorReportPdf(req.app, {
            report: mobileWebParityMapper.toClientReportDto(report),
            generatedAt: new Date()
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length);
        res.setHeader('Content-Disposition', 'attachment; filename="ahram-client-report.pdf"');
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        return res.end(pdf);
    } catch (e) {
        console.error('[mobile/client-report-pdf] failed:', e.stack || e.message);
        const status = e.code === 'PDF_BROWSER_NOT_FOUND' ? 503 : 403;
        return res.status(status).send(
            e.code === 'PDF_BROWSER_NOT_FOUND'
                ? 'تعذر تشغيل محرك PDF على الخادم.'
                : 'رابط تنزيل التقرير غير صالح أو انتهت صلاحيته.'
        );
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
router.get('/executor/overview', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        const result = await mobileWebParityService.getExecutorOverview({
            executorId: req.user.userId,
            tenantId: req.tenant ? req.tenant._id : null
        });
        return res.json({ success: true, data: result, serverTime: new Date().toISOString() });
    } catch (e) {
        if (e.message === 'UNAUTHORIZED') {
            return sendMobileError(res, 401, 'UNAUTHORIZED', 'غير مصرح بالوصول', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء جلب ملخص المنفذ');
    }
});

router.post('/executor/reports/filter', authenticateJWT, executorReportsValidator, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        const { userId } = req.user;
        const { dateType, dateValue, employeeId } = req.body;
        
        const result = await mobileWebParityService.getExecutorReports({
            executorId: userId,
            dateType,
            dateValue,
            employeeId,
            tenantId: req.tenant ? req.tenant._id : null
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
        if (e.message === 'FORBIDDEN') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'لا تملك صلاحية عرض تقرير هذا الموظف', req.correlationId);
        }
        if (e.message === 'NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الموظف غير موجود ضمن شركة التنفيذ', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء جلب التقارير');
    }
});

// 👥 Executor Employee Management (Manager only)
router.post('/executor/reports/download-link', authenticateJWT, executorReportsValidator, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        const { dateType, dateValue, employeeId } = req.body;
        await mobileWebParityService.getExecutorReports({
            executorId: req.user.userId,
            dateType,
            dateValue,
            employeeId,
            tenantId: req.tenant ? req.tenant._id : null
        });

        const token = createReportDownloadToken({
            executorId: String(req.user.userId),
            dateType: dateType === 'month' ? 'month' : 'day',
            dateValue: String(dateValue || ''),
            employeeId: employeeId ? String(employeeId) : null,
            tenantId: req.tenant ? String(req.tenant._id) : null,
            expiresAt: Date.now() + REPORT_DOWNLOAD_TTL_MS
        });
        const configuredBaseUrl = String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
        const baseUrl = configuredBaseUrl || `${req.protocol}://${req.get('host')}`;
        return res.json({
            success: true,
            downloadUrl: `${baseUrl}/api/mobile/executor/reports/download.pdf?token=${encodeURIComponent(token)}`
        });
    } catch (e) {
        if (['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(e.message)) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'لا تملك صلاحية تنزيل هذا التقرير', req.correlationId);
        }
        if (e.code === 'REPORT_DOWNLOAD_NOT_CONFIGURED') {
            return sendMobileError(res, 503, 'REPORT_DOWNLOAD_NOT_CONFIGURED', 'إعداد تنزيل التقارير غير مكتمل على الخادم', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء تجهيز ملف التقرير');
    }
});

router.get('/executor/reports/download.pdf', async (req, res) => {
    try {
        const payload = readReportDownloadToken(req.query.token);
        const report = await mobileWebParityService.getExecutorReports({
            executorId: payload.executorId,
            dateType: payload.dateType,
            dateValue: payload.dateValue,
            employeeId: payload.employeeId,
            tenantId: payload.tenantId || null
        });
        const pdf = await generateExecutorReportPdf(req.app, {
            report: mobileWebParityMapper.toClientReportDto(report),
            generatedAt: new Date()
        });
        const datePart = String(report.reportPeriod?.value || '').replace(/[^0-9-]/g, '') || Date.now();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdf.length);
        res.setHeader('Content-Disposition', `attachment; filename="executor-report-${datePart}.pdf"`);
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        return res.end(pdf);
    } catch (e) {
        console.error('[mobile/executor-report-pdf] failed:', e.stack || e.message);
        const status = e.code === 'PDF_BROWSER_NOT_FOUND' ? 503 : 403;
        return res.status(status).send(
            e.code === 'PDF_BROWSER_NOT_FOUND'
                ? 'تعذر تشغيل محرك PDF على الخادم.'
                : 'رابط تنزيل التقرير غير صالح أو انتهت صلاحيته.'
        );
    }
});

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

router.patch('/executor/employees/:id/profile', authenticateJWT, updateExecutorEmployeeProfileValidator, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        const updated = await mobileWebParityService.updateEmployeeProfile({
            executorId: req.user.userId,
            targetId: req.params.id,
            name: req.body.name,
            phone: req.body.phone
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
            return sendMobileError(res, 403, 'FORBIDDEN', 'ليس لديك صلاحيات مدير لتعديل بيانات الموظف', req.correlationId);
        }
        if (e.message === 'NOT_FOUND') {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الموظف غير موجود أو لا ينتمي إلى مجموعتك', req.correlationId);
        }
        return sendServerError(res, req, 'حدث خطأ أثناء تعديل بيانات الموظف');
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
