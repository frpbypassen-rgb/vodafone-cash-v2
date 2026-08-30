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
const securityControl = require('../services/securityControlService');

const { authenticateJWT } = require('../middlewares/jwtAuth');
const correlationId = require('../middlewares/correlationId');
const requireIdempotencyKey = require('../middlewares/requireIdempotencyKey');
const { logAction } = require('../services/auditService');
const { verifyAndUpgradePassword } = require('../utils/helpers');
const { proofSourceUrl, saveProofImage, streamProofImage } = require('../services/proofStorageService');
const { createReceiptImageUrl } = require('../services/receiptShareService');
const { getClientReceiptProofIds } = require('../services/clientReceiptService');
const { saveProfilePhoto, streamProfilePhoto, removeProfilePhoto } = require('../services/profilePhotoStorageService');
const authController = require('../controllers/auth/authController');
const transferService = require('../services/transferService');
const { deviceTrustMiddleware } = require('../src/Presentation/Middlewares/deviceTrustMiddleware');
const { mfaMiddleware } = require('../src/Presentation/Middlewares/mfaMiddleware');
const requireOperationPin = require('../middlewares/requireOperationPin');
const operationPinService = require('../services/operationPinService');
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
const executorDepositRequestService = require('../services/executorDepositRequestService');
const executorSupportService = require('../services/executorSupportService');
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
    ExecutorSenderEntriesError,
    normalizeExecutorSenderEntries
} = require('../utils/executorSenderEntries');
const {
    ManualExecutionNumberError,
    maskManualExecutionNumber,
    generateManualExecutorReceiptBase64
} = require('../utils/manualExecutorReceipt');
const { reserveManualExecutorReceiptReference } = require('../services/manualExecutorReceiptReferenceService');
const {
    acknowledgeMobilePushTask,
    getMobilePushDeviceStatus,
    listMobileNotificationInbox,
    markAllMobileNotificationsRead,
    markMobileNotificationRead,
    registerMobilePushDevice,
    sendMobilePushTest,
    snoozeMobilePushTask,
    updateMobilePushPreferences,
    unregisterMobilePushDevice
} = require('../services/executorPushNotificationService');
const { activatePendingRateUpdate } = require('../services/rateChangeService');
const { buildPendingRateAlertForClient } = require('../services/rateAlerts/rateAlertAudienceService');
const { reversalService } = require('../src/Application/Services/ReversalService');
const accountMfaService = require('../services/accountMfaService');
const eventBus = require('../services/eventBus');
const {
    acceptExecutorTask,
    executorIdentityKeys,
    findOwnedAcceptedExecutorTask,
    taskOwnershipFilter,
    listRouteCandidates,
    routeExecutorTask,
    routingErrorMessage
} = require('../services/executorTaskRoutingService');
const { buildExecutorTaskRecipient } = require('../utils/executorTaskPrivacy');
const {
    findBrowserExecutable,
    getSharedBrowser,
    logoDataUri,
    renderView
} = require('../services/reportPdfService');

const router = express.Router();

// Legacy execution records created before tenant migration have no tenantId.
// They are accepted only by the configured single-tenant deployment.
const executorTenantScope = (req) => {
    if (!req.tenant?._id) return null;
    return String(process.env.TENANT_MODE || '').trim().toLowerCase() === 'single'
        ? { $in: [req.tenant._id, null] }
        : req.tenant._id;
};

// The group id in a signed executor token is issued after authentication.
// It is used only for legacy employee records that have no persisted groupId,
// keeping their queue available without accepting a client-selected group.
const executorWithSessionGroup = (employee, sessionGroupId) => {
    if (!employee || employee.groupId || !sessionGroupId) return employee;
    const source = typeof employee.toObject === 'function'
        ? employee.toObject()
        : employee;
    return {
        ...source,
        groupId: {
            _id: sessionGroupId,
            manualTaskRoutingEnabled: false
        }
    };
};

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
    const executablePath = await findBrowserExecutable();
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

const sendExecutorSupportError = (res, req, error, fallbackMessage) => {
    const status = Number(error?.status || 500);
    const code = error?.code || (status >= 500 ? 'SERVER_ERROR' : 'SUPPORT_ERROR');
    const message = status >= 500
        ? fallbackMessage
        : (error?.message || fallbackMessage);
    return sendMobileError(res, status, code, message, req.correlationId);
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

const toExecutorTaskDto = (tx, currentExecutorId = null) => {
    const recipient = buildExecutorTaskRecipient(tx, currentExecutorId);
    return {
        id: tx._id ? String(tx._id) : null,
        txId: tx.customId || null,
        transferType: tx.transferType || null,
        transferTypeLabel: getTransferServiceLabel(tx.transferType),
        amount: Number(tx.amount || 0),
        ...recipient,
        recipientName: tx.accountName || null,
        nationalId: recipient.recipientRevealed ? (tx.nationalId || null) : null,
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
            currentExecutorId && tx.status === 'accepted' && (() => {
                const operatorId = tx.operatorId ? String(tx.operatorId) : '';
                const assignedExecutorId = tx.assignedExecutorId ? String(tx.assignedExecutorId) : '';
                return (!operatorId || operatorId === String(currentExecutorId))
                    && (!assignedExecutorId || assignedExecutorId === String(currentExecutorId))
                    && (operatorId === String(currentExecutorId) || assignedExecutorId === String(currentExecutorId));
            })()
        ),
        executorReceivedAt: tx.executorReceivedAt
            ? new Date(tx.executorReceivedAt).toISOString()
            : (tx.createdAt ? new Date(tx.createdAt).toISOString() : null),
        createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
        emergencyAlert: tx.emergencyAlert || null
    };
};

router.use(correlationId);

const resolveMfaAccount = async (req) => {
    if (!req.user?.userId || !req.user?.accountType) return null;
    return accountMfaService.loadAccount(
        req.user.accountType,
        req.user.userId,
        req.user.tenantId || (req.tenant && req.tenant._id) || null
    );
};

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
            tenantId: (req.tenant && req.tenant._id) || undefined,
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
            tenantId: (req.tenant && req.tenant._id) || agent.tenantId || undefined,
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
            tenantId: (req.tenant && req.tenant._id) || undefined,
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
            tenantId: (req.tenant && req.tenant._id) || undefined,
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

router.post('/push/devices/register', authenticateJWT, async (req, res) => {
    try {
        const device = await registerMobilePushDevice({ user: req.user, payload: req.body || {} });
        const status = await getMobilePushDeviceStatus({
            user: req.user,
            installationId: req.body?.installationId
        });
        return res.json({
            success: true,
            device: {
                id: String(device._id),
                enabled: device.enabled,
                permissionStatus: device.permissionStatus,
                platform: device.platform,
                lastSeenAt: device.lastSeenAt
            },
            firebase: status.firebase
        });
    } catch (error) {
        const clientError = ['INVALID_INSTALLATION_ID', 'INVALID_PUSH_TOKEN', 'EXECUTOR_NOT_ACTIVE'].includes(error.code);
        return sendMobileError(
            res,
            clientError ? 400 : 500,
            error.code || 'PUSH_DEVICE_REGISTRATION_FAILED',
            clientError ? 'تعذر تسجيل هذا الجهاز لاستقبال الإشعارات.' : 'تعذر تفعيل إشعارات الهاتف حالياً.',
            req.correlationId
        );
    }
});

const unregisterPushDeviceHandler = async (req, res) => {
    try {
        const installationId = req.body?.installationId || req.query?.installationId;
        if (!installationId) {
            return sendMobileError(res, 400, 'INVALID_INSTALLATION_ID', 'معرف تثبيت التطبيق مطلوب.', req.correlationId);
        }
        await unregisterMobilePushDevice({ user: req.user, installationId });
        return res.json({ success: true });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_DEVICE_UNREGISTER_FAILED', 'تعذر إيقاف إشعارات هذا الجهاز.', req.correlationId);
    }
};

router.delete('/push/devices/current', authenticateJWT, unregisterPushDeviceHandler);
router.post('/push/devices/unregister', authenticateJWT, unregisterPushDeviceHandler);

router.get('/push/devices/status', authenticateJWT, async (req, res) => {
    try {
        const status = await getMobilePushDeviceStatus({
            user: req.user,
            installationId: req.query?.installationId
        });
        return res.json({ success: true, ...status });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_DEVICE_STATUS_FAILED', 'تعذر فحص حالة إشعارات الهاتف.', req.correlationId);
    }
});

router.post('/push/tasks/:id/ack', authenticateJWT, async (req, res) => {
    try {
        const installationId = req.body?.installationId;
        if (!installationId) {
            return sendMobileError(res, 400, 'INVALID_INSTALLATION_ID', 'معرف تثبيت التطبيق مطلوب.', req.correlationId);
        }
        await acknowledgeMobilePushTask({
            user: req.user,
            installationId,
            transactionId: req.params.id
        });
        return res.json({ success: true });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_TASK_ACK_FAILED', 'تعذر تسجيل فتح إشعار العملية.', req.correlationId);
    }
});

router.post('/push/tasks/:id/snooze', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الميزة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const installationId = req.body?.installationId;
        if (!installationId) {
            return sendMobileError(res, 400, 'INVALID_INSTALLATION_ID', 'معرف تثبيت التطبيق مطلوب.', req.correlationId);
        }
        const result = await snoozeMobilePushTask({
            user: req.user,
            installationId,
            transactionId: req.params.id,
            minutes: req.body?.minutes
        });
        return res.json({ success: true, ...result });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_TASK_SNOOZE_FAILED', 'تعذر كتم تنبيه العملية مؤقتاً.', req.correlationId);
    }
});

router.get('/push/preferences', authenticateJWT, async (req, res) => {
    try {
        const status = await getMobilePushDeviceStatus({
            user: req.user,
            installationId: req.query?.installationId
        });
        return res.json({
            success: true,
            preferences: status.device?.notificationPreferences || {},
            device: status.device || null
        });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_PREFERENCES_FAILED', 'تعذر تحميل تفضيلات الإشعارات.', req.correlationId);
    }
});

router.patch('/push/preferences', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الميزة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const installationId = req.body?.installationId;
        if (!installationId) {
            return sendMobileError(res, 400, 'INVALID_INSTALLATION_ID', 'معرف تثبيت التطبيق مطلوب.', req.correlationId);
        }
        const preferences = await updateMobilePushPreferences({
            user: req.user,
            installationId,
            preferences: req.body?.preferences || {}
        });
        return res.json({ success: true, preferences });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_PREFERENCES_UPDATE_FAILED', 'تعذر حفظ تفضيلات الإشعارات.', req.correlationId);
    }
});

router.get('/push/inbox', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'سجل الإشعارات مخصص لحسابات التنفيذ.', req.correlationId);
        }
        const result = await listMobileNotificationInbox({
            user: req.user,
            category: req.query?.category,
            unreadOnly: String(req.query?.unreadOnly || '') === 'true',
            page: req.query?.page,
            limit: req.query?.limit
        });
        return res.json({
            success: true,
            ...result,
            items: result.items.map((item) => ({ ...item, id: String(item._id), _id: undefined }))
        });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_INBOX_FAILED', 'تعذر تحميل سجل الإشعارات.', req.correlationId);
    }
});

router.post('/push/inbox/read-all', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'سجل الإشعارات مخصص لحسابات التنفيذ.', req.correlationId);
        }
        const result = await markAllMobileNotificationsRead({ user: req.user });
        return res.json({ success: true, updated: result.modifiedCount || 0 });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_INBOX_UPDATE_FAILED', 'تعذر تحديث سجل الإشعارات.', req.correlationId);
    }
});

router.post('/push/inbox/:id/read', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor' || !mongoose.Types.ObjectId.isValid(req.params.id)) {
            return sendMobileError(res, 400, 'INVALID_NOTIFICATION_ID', 'معرف الإشعار غير صالح.', req.correlationId);
        }
        const item = await markMobileNotificationRead({ user: req.user, notificationId: req.params.id });
        if (!item) return sendMobileError(res, 404, 'NOT_FOUND', 'الإشعار غير موجود.', req.correlationId);
        return res.json({ success: true });
    } catch (_) {
        return sendMobileError(res, 500, 'PUSH_INBOX_UPDATE_FAILED', 'تعذر تحديث الإشعار.', req.correlationId);
    }
});

router.post('/push/devices/test', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'اختبار الإشعار متاح لحسابات التنفيذ فقط.', req.correlationId);
        }
        const installationId = req.body?.installationId;
        if (!installationId) {
            return sendMobileError(res, 400, 'INVALID_INSTALLATION_ID', 'معرف تثبيت التطبيق مطلوب.', req.correlationId);
        }
        const allowedCategories = [
            'executor_task_new',
            'executor_task_routed',
            'executor_task_reminder',
            'executor_urgent_alert',
            'executor_task_completed',
            'executor_task_cancelled',
            'executor_support_reply',
            'executor_balance_warning',
            'executor_security_alert',
            'executor_report_ready'
        ];
        const category = allowedCategories.includes(req.body?.category)
            ? req.body.category
            : 'executor_task_new';
        const result = await sendMobilePushTest({ user: req.user, installationId, category });
        return res.json({ success: true, acceptedByFirebase: result.successCount });
    } catch (error) {
        const status = ['PUSH_DEVICE_NOT_REGISTERED', 'PUSH_TEST_DELIVERY_FAILED'].includes(error.code) ? 409 : 503;
        return sendMobileError(
            res,
            status,
            error.code || 'FCM_NOT_CONFIGURED',
            error.code === 'PUSH_DEVICE_NOT_REGISTERED'
                ? 'هذا الهاتف غير مسجل لاستقبال الإشعارات بعد.'
                : 'تعذر إرسال إشعار الاختبار. راجع إعدادات Firebase في الخادم والتطبيق.',
            req.correlationId
        );
    }
});

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

    // Pricing tiers are internal administration data. The rate contract below
    // exposes only the actual prices this account may use.
    const { tier: _internalTier, tierLabel: _internalTierLabel, ...publicRateContract } = rateContract;
    const pendingRateUpdate = await buildPendingRateAlertForClient({
        accountType,
        clientId: userId,
        settings
    });
    const responseData = {
        success: true,
        balance: Number(balance),
        ...publicRateContract,
        isOpen: !(settings && settings.isManualClosed),
        serverTime: new Date().toISOString(),
        pendingRateUpdate
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

        await activatePendingRateUpdate({ app: req.app });
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

        await activatePendingRateUpdate({ app: req.app });
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
    requireOperationPin,
    transferLimiter,
    requireIdempotencyKey,
    transferValidator,
    async (req, res) => {
        try {
            await activatePendingRateUpdate({ app: req.app });
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
        if (req.tenant) employeeQuery.tenantId = executorTenantScope(req);
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
        const effectiveEmployee = executorWithSessionGroup(employee, executorGroupId);
        if (!effectiveEmployee?.groupId) {
            return sendMobileError(res, 409, 'EXECUTOR_GROUP_MISSING', 'حساب المنفذ غير مرتبط بشركة تنفيذ.', req.correlationId);
        }

        const queryTasks = {
            ...taskOwnershipFilter(effectiveEmployee),
            // Some legacy/queue transitions expose a grouped task as pending
            // for a short period. Keep it actionable instead of showing a
            // stale card that inevitably fails on accept.
            status: { $in: ['processing', 'pending', 'accepted'] }
        };
        if (req.tenant) queryTasks.tenantId = executorTenantScope(req);
        const tasks = await Transaction.find(queryTasks).sort({ createdAt: 1 }).lean();

        const queryAlerts = {
            ...taskOwnershipFilter(effectiveEmployee),
            emergencyAlert: { $exists: true, $ne: null },
            status: { $in: ['processing', 'pending', 'accepted'] }
        };
        if (req.tenant) queryAlerts.tenantId = executorTenantScope(req);
        const alerts = await Transaction.find(queryAlerts).lean();

        return res.json({
            success: true,
            data: tasks.map((task) => toExecutorTaskDto(task, userId)),
            alerts: alerts.map((task) => toExecutorTaskDto(task, userId)),
            manualTaskRoutingEnabled: Boolean(effectiveEmployee.groupId?.manualTaskRoutingEnabled),
            canRouteTasks: effectiveEmployee.role === 'manager',
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
        if (req.tenant) empQuery.tenantId = executorTenantScope(req);
        const emp = await Employee.findOne(empQuery).populate('groupId');
        if (!emp) {
            return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        }

        if (emp.role === 'accountant') {
            return sendMobileError(res, 403, 'TASKS_FORBIDDEN', 'صلاحيات المحاسب لا تسمح بتنفيذ العمليات', req.correlationId);
        }

        const effectiveEmployee = executorWithSessionGroup(emp, req.user.executorGroupId);
        const groupId = effectiveEmployee?.groupId && (effectiveEmployee.groupId._id || effectiveEmployee.groupId);
        if (!groupId) {
            return sendMobileError(res, 409, 'EXECUTOR_GROUP_MISSING', 'حساب المنفذ غير مرتبط بشركة تنفيذ.', req.correlationId);
        }

        const acceptance = await acceptExecutorTask({
            transactionId: req.params.id,
            executor: effectiveEmployee,
            tenantId: req.tenant ? executorTenantScope(req) : null
        });
        if (!acceptance.ok) {
            const conflictCodes = new Set([
                'ACTIVE_TASK_EXISTS',
                'TASK_UNAVAILABLE',
                'TASK_NOT_FOUND',
                'TASK_TENANT_MISMATCH',
                'TASK_GROUP_MISMATCH',
                'TASK_TAKEN',
                'TASK_ASSIGNED_TO_OTHER',
                'TASK_STATE_CHANGED'
            ]);
            const status = conflictCodes.has(acceptance.code) ? 409 : 400;
            const message = acceptance.acceptedByName
                ? `${routingErrorMessage(acceptance.code)} (${acceptance.acceptedByName})`
                : acceptance.assignedExecutorName
                ? `${routingErrorMessage(acceptance.code)} (${acceptance.assignedExecutorName})`
                : routingErrorMessage(acceptance.code);
            return sendMobileError(res, status, acceptance.code, message, req.correlationId);
        }
        return res.json({ success: true, replayed: acceptance.replayed === true });

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
        if (req.tenant) employeeQuery.tenantId = executorTenantScope(req);
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
        if (req.tenant) employeeQuery.tenantId = executorTenantScope(req);
        const manager = await Employee.findOne(employeeQuery).populate('groupId');
        if (!manager?.groupId) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه العملية متاحة لمدير التنفيذ فقط.', req.correlationId);
        }
        const employees = await listRouteCandidates({
            groupId: manager.groupId._id || manager.groupId,
            tenantId: req.tenant ? executorTenantScope(req) : null
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
        if (req.tenant) employeeQuery.tenantId = executorTenantScope(req);
        const manager = await Employee.findOne(employeeQuery).populate('groupId');
        const result = await routeExecutorTask({
            transactionId: req.params.id,
            manager,
            employeeId: req.body?.employeeId,
            tenantId: req.tenant ? executorTenantScope(req) : null
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

const mobileSecurityPrincipal = (req) => ({
    principalType: req.user.accountType,
    principalId: String(req.user.userId),
    principalName: String(req.user.name || req.user.webUsername || req.user.accountType || 'حساب التطبيق')
});

const mobileSecurityActionError = (res, req, error) => {
    const status = error.code === 'SECURITY_DEVICE_NOT_FOUND'
        || error.code === 'SECURITY_ACCESS_REQUEST_NOT_FOUND'
        ? 404
        : (error.code === 'SECURITY_ACCESS_REQUEST_EXPIRED' ? 410 : 400);
    const messages = {
        SECURITY_DEVICE_NOT_FOUND: 'الجلسة غير موجودة أو تم إنهاؤها بالفعل',
        SECURITY_ACCESS_REQUEST_NOT_FOUND: 'طلب الجهاز غير موجود أو تمت مراجعته',
        SECURITY_ACCESS_REQUEST_EXPIRED: 'انتهت صلاحية طلب الجهاز. أعد محاولة تسجيل الدخول'
    };
    return sendMobileError(
        res,
        status,
        error.code || 'SECURITY_SESSION_ACTION_FAILED',
        messages[error.code] || 'تعذر تنفيذ إجراء الجلسة',
        req.correlationId
    );
};

const getMobileSecuritySessions = async (req, res) => {
    try {
        const data = await securityControl.listPrincipalSessions({
            principal: mobileSecurityPrincipal(req),
            req
        });
        return res.json({ success: true, ...data });
    } catch (error) {
        return mobileSecurityActionError(res, req, error);
    }
};

router.get('/security/sessions', authenticateJWT, getMobileSecuritySessions);
router.get('/client/security/devices', authenticateJWT, getMobileSecuritySessions);

router.post('/security/sessions/:id/revoke', authenticateJWT, async (req, res) => {
    try {
        const principal = mobileSecurityPrincipal(req);
        const result = await securityControl.revokePrincipalDevice({
            principal,
            deviceId: req.params.id,
            req,
            reason: 'revoked_by_account_owner'
        });
        if (result.device.channel === 'app' && ['client_user', 'sub_client'].includes(req.user.accountType)) {
            await MobileDeviceSession.updateMany(
                { accountId: req.user.userId, accountType: req.user.accountType, active: true },
                { $set: { active: false, revokedAt: new Date(), revokeReason: 'security_device_revoked', lastSeenAt: new Date() } }
            );
        }
        await logAction({
            action: 'SECURITY_DEVICE_REVOKED_BY_OWNER', req,
            performedById: principal.principalId,
            performedByName: principal.principalName,
            targetId: result.device._id,
            targetModel: 'SecurityDevice',
            severity: 'warning',
            metadata: { channel: result.device.channel, current: result.current }
        });
        return res.json({ success: true, currentRevoked: result.current });
    } catch (error) {
        return mobileSecurityActionError(res, req, error);
    }
});

router.post('/security/session-requests/:id/:decision', authenticateJWT, async (req, res) => {
    try {
        const decision = String(req.params.decision || '');
        if (!['approve', 'reject'].includes(decision)) {
            return sendMobileError(res, 400, 'VALIDATION_ERROR', 'قرار الطلب غير صالح', req.correlationId);
        }
        const principal = mobileSecurityPrincipal(req);
        const result = await securityControl.reviewPrincipalAccessRequest({
            principal,
            requestId: req.params.id,
            approve: decision === 'approve',
            reviewedBy: principal.principalName,
            reviewNote: req.body?.note
        });
        if (decision === 'approve'
            && result.request.channel === 'app'
            && ['client_user', 'sub_client'].includes(req.user.accountType)) {
            await MobileDeviceSession.updateMany(
                { accountId: req.user.userId, accountType: req.user.accountType, active: true },
                { $set: { active: false, revokedAt: new Date(), revokeReason: 'replaced_by_approved_app', lastSeenAt: new Date() } }
            );
        }
        await logAction({
            action: decision === 'approve' ? 'SECURITY_DEVICE_APPROVED_BY_OWNER' : 'SECURITY_DEVICE_REJECTED_BY_OWNER',
            req,
            performedById: principal.principalId,
            performedByName: principal.principalName,
            targetId: result.request._id,
            targetModel: 'SecurityAccessRequest',
            severity: 'warning',
            metadata: { channel: result.request.channel, requestCode: result.request.requestCode }
        });
        return res.json({ success: true, channel: result.request.channel });
    } catch (error) {
        return mobileSecurityActionError(res, req, error);
    }
});

// ─────────────────────────────────────────────────────────────────────────
// MFA / Authenticator — حساب واحد، جهاز موثوق واحد، مدة الثقة 24 ساعة.
// هذه المسارات مستقلة عن منطق التحويلات حتى لا تتأثر العمليات المالية.
const enrollmentAccountFromRequest = async (req) => {
    const token = String(req.body?.mfaEnrollmentToken || req.headers['x-mfa-enrollment-token'] || '').trim();
    const challenge = accountMfaService.verifyEnrollmentChallenge(token);
    const suppliedHash = securityControl.hashDeviceId(accountMfaService.deviceIdFor(req));
    if (challenge.deviceIdHash !== require('crypto').createHash('sha256').update(accountMfaService.deviceIdFor(req)).digest('hex')) {
        const error = new Error('MFA_ENROLLMENT_DEVICE_MISMATCH'); error.code = 'MFA_ENROLLMENT_DEVICE_MISMATCH'; throw error;
    }
    const activeDevice = await require('../models/SecurityDevice').findOne({
        principalType: challenge.accountType,
        principalId: String(challenge.userId),
        status: 'active',
        deviceIdHash: suppliedHash
    }).select('_id');
    if (!activeDevice) {
        const error = new Error('MFA_ENROLLMENT_NOT_APPROVED'); error.code = 'MFA_ENROLLMENT_NOT_APPROVED'; throw error;
    }
    return accountMfaService.loadAccount(challenge.accountType, challenge.userId, challenge.tenantId || null);
};

router.post('/auth/mfa-enrollment/setup', async (req, res) => {
    try {
        const account = await enrollmentAccountFromRequest(req);
        if (!account) return sendMobileError(res, 404, 'USER_NOT_FOUND', 'الحساب غير موجود', req.correlationId);
        if (accountMfaService.isEnabled(account)) return sendMobileError(res, 409, 'MFA_ALREADY_ENABLED', 'Authenticator مفعل بالفعل', req.correlationId);
        const data = accountMfaService.setup(account);
        return res.json({ success: true, type: 'totp', secret: data.secret, qrUri: data.qrUri, recoveryCodes: data.recoveryCodes });
    } catch (error) {
        return sendMobileError(res, 403, error.code || 'MFA_ENROLLMENT_INVALID', 'انتهت أو لم تُعتمد محاولة تفعيل الحماية.', req.correlationId);
    }
});

router.post('/auth/mfa-enrollment/confirm', async (req, res) => {
    try {
        const account = await enrollmentAccountFromRequest(req);
        const secret = String(req.body?.secret || '').trim().toUpperCase();
        const token = String(req.body?.token || '').trim();
        const recoveryCodes = Array.isArray(req.body?.recoveryCodes) ? req.body.recoveryCodes : [];
        if (!account || !secret || !token || recoveryCodes.length < 6) return sendMobileError(res, 400, 'VALIDATION_ERROR', 'بيانات Authenticator غير مكتملة', req.correlationId);
        await accountMfaService.confirmSetup(account, secret, token, recoveryCodes);
        return res.json({ success: true, message: 'تم تفعيل Authenticator. سجّل الدخول مرة أخرى باستخدام الرمز.' });
    } catch (error) {
        return sendMobileError(res, error.code === 'MFA_INVALID' ? 400 : 403, error.code || 'MFA_ENROLLMENT_INVALID', error.code === 'MFA_INVALID' ? 'رمز Authenticator غير صحيح' : 'تعذر تأكيد تفعيل الحماية.', req.correlationId);
    }
});

router.get('/security/mfa/status', authenticateJWT, async (req, res) => {
    try {
        const account = await resolveMfaAccount(req);
        if (!account) return sendMobileError(res, 404, 'USER_NOT_FOUND', 'الحساب غير موجود', req.correlationId);
        const trustedDevice = await accountMfaService.isDeviceTrusted({
            account,
            accountType: req.user.accountType,
            deviceId: accountMfaService.deviceIdFor(req),
            sessionId: req.user.sessionId
        });
        const activeTrust = trustedDevice
            ? await require('../models/TrustedDevice').findOne({
                accountId: account._id,
                accountType: req.user.accountType,
                channel: 'app',
                active: true,
                expiresAt: { $gt: new Date() },
                deviceIdHash: require('crypto').createHash('sha256').update(accountMfaService.deviceIdFor(req)).digest('hex')
            }).select('deviceType userAgent trustedAt expiresAt lastSeenAt').lean()
            : null;
        return res.json({ success: true, ...accountMfaService.status(account), trustedDevice: activeTrust || null });
    } catch (_) {
        return sendServerError(res, req, 'تعذر تحميل إعدادات المصادقة الثنائية');
    }
});

router.post('/security/mfa/setup', authenticateJWT, async (req, res) => {
    try {
        const account = await resolveMfaAccount(req);
        if (!account) return sendMobileError(res, 404, 'USER_NOT_FOUND', 'الحساب غير موجود', req.correlationId);
        if (accountMfaService.isEnabled(account)) {
            return sendMobileError(res, 409, 'MFA_ALREADY_ENABLED', 'المصادقة الثنائية مفعلة بالفعل', req.correlationId);
        }
        const data = accountMfaService.setup(account);
        return res.json({
            success: true,
            type: 'totp',
            secret: data.secret,
            qrUri: data.qrUri,
            recoveryCodes: data.recoveryCodes,
            message: 'امسح رمز QR في تطبيق Authenticator ثم أدخل الرمز للتأكيد. رموز الاسترداد تظهر مرة واحدة فقط.'
        });
    } catch (_) {
        return sendServerError(res, req, 'تعذر بدء إعداد المصادقة الثنائية');
    }
});

router.post('/security/mfa/confirm', authenticateJWT, async (req, res) => {
    try {
        const account = await resolveMfaAccount(req);
        const secret = String(req.body?.secret || '').trim().toUpperCase();
        const token = String(req.body?.token || '').trim();
        const recoveryCodes = Array.isArray(req.body?.recoveryCodes) ? req.body.recoveryCodes : [];
        if (!account || !secret || !token || recoveryCodes.length < 6) {
            return sendMobileError(res, 400, 'VALIDATION_ERROR', 'بيانات تفعيل Authenticator غير مكتملة', req.correlationId);
        }
        await accountMfaService.confirmSetup(account, secret, token, recoveryCodes);
        await accountMfaService.trustDevice({
            account,
            accountType: req.user.accountType,
            tenantId: req.user.tenantId || (req.tenant && req.tenant._id) || null,
            deviceId: accountMfaService.deviceIdFor(req),
            sessionId: req.user.sessionId || null,
            req
        });
        return res.json({ success: true, ...accountMfaService.status(account), message: 'تم تفعيل المصادقة الثنائية بنجاح' });
    } catch (error) {
        if (error.code === 'MFA_INVALID') return sendMobileError(res, 400, 'MFA_INVALID', 'رمز Authenticator غير صحيح', req.correlationId);
        return sendServerError(res, req, 'تعذر تأكيد تفعيل المصادقة الثنائية');
    }
});

router.post('/security/mfa/disable', authenticateJWT, async (req, res) => {
    try {
        const account = await resolveMfaAccount(req);
        if (!account) return sendMobileError(res, 404, 'USER_NOT_FOUND', 'الحساب غير موجود', req.correlationId);
        await accountMfaService.disable(account, String(req.body?.token || ''));
        return res.json({ success: true, ...accountMfaService.status(account), message: 'تم إيقاف المصادقة الثنائية وإلغاء الأجهزة الموثوقة' });
    } catch (error) {
        if (error.code === 'MFA_INVALID') return sendMobileError(res, 400, 'MFA_INVALID', 'رمز Authenticator أو رمز الاسترداد غير صحيح', req.correlationId);
        return sendServerError(res, req, 'تعذر إيقاف المصادقة الثنائية');
    }
});

router.get('/security/mfa/trusted-device', authenticateJWT, async (req, res) => {
    try {
        const account = await resolveMfaAccount(req);
        if (!account) return sendMobileError(res, 404, 'USER_NOT_FOUND', 'الحساب غير موجود', req.correlationId);
        const device = await require('../models/TrustedDevice').findOne({
            accountId: account._id,
            accountType: req.user.accountType,
            channel: 'app',
            active: true,
            expiresAt: { $gt: new Date() },
            deviceIdHash: require('crypto').createHash('sha256').update(accountMfaService.deviceIdFor(req)).digest('hex')
        }).select('deviceType userAgent trustedAt expiresAt lastSeenAt').lean();
        return res.json({ success: true, device: device || null });
    } catch (_) {
        return sendServerError(res, req, 'تعذر تحميل الجهاز الموثوق');
    }
});

router.post('/security/mfa/trusted-device/revoke', authenticateJWT, async (req, res) => {
    try {
        const account = await resolveMfaAccount(req);
        if (!account) return sendMobileError(res, 404, 'USER_NOT_FOUND', 'الحساب غير موجود', req.correlationId);
        await require('../models/TrustedDevice').updateMany(
            { accountId: account._id, accountType: req.user.accountType, channel: 'app', active: true },
            { $set: { active: false, revokedAt: new Date(), revokeReason: 'user_revoked' } }
        );
        return res.json({ success: true, message: 'تم إلغاء الجهاز الموثوق. سيطلب النظام رمز Authenticator عند الدخول القادم.' });
    } catch (_) {
        return sendServerError(res, req, 'تعذر إلغاء الجهاز الموثوق');
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
        const employeeRecord = await Employee.findOne(empQuery).populate('groupId');
        const emp = executorWithSessionGroup(employeeRecord, req.user.executorGroupId);
        if (!emp) throw new Error('EMPLOYEE_NOT_FOUND');
        if (emp.role === 'accountant') throw new Error('TASKS_FORBIDDEN');

        const executorIdentityQuery = executorIdentityKeys(emp);
        const txQuery = {
            _id: req.params.id,
            status: 'accepted',
            $or: [
                { operatorId: { $in: executorIdentityQuery } },
                { assignedExecutorId: { $in: executorIdentityQuery } }
            ]
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
 *                 description: صورة إثبات اختيارية بصيغة Base64.
 *                 example: "data:image/jpeg;base64,/9j/4AAQSkZJR..."
 *               senderPhone:
 *                 type: string
 *                 description: رقم مرسل legacy اختياري عند استخدام رقم واحد
 *                 example: "01012345678"
 *               senderEntries:
 *                 type: array
 *                 maxItems: 5
 *                 description: أرقام مرسل اختيارية. عند إدخال رقم واحد تُسند إليه قيمة العملية تلقائياً، وعند إدخال أكثر من رقم يجب إرسال قيمة كل رقم ومطابقة مجموعها لقيمة العملية.
 *                 items:
 *                   type: object
 *                   required:
 *                     - phone
 *                   properties:
 *                     phone:
 *                       type: string
 *                       pattern: '^\\d{11}$'
 *                       example: "01108172258"
 *                     amount:
 *                       type: number
 *                       minimum: 0.01
 *                       example: 40
 *     responses:
 *       200:
 *         description: تم إنهاء العملية بنجاح وإرسال الإثبات
 */
router.post('/executor/complete-task/:id', authenticateJWT, completeTaskValidator, async (req, res) => {
    try {
        const {
            imageBase64,
            imagesBase64,
            executionNumber: requestedExecutionNumber,
            senderPhone,
            senderEntries: requestedSenderEntries
        } = req.body;
        const executionNumber = String(requestedExecutionNumber ?? senderPhone ?? '').trim();
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        if (!/^\d{11}$/.test(executionNumber)) {
            return sendMobileError(res, 400, 'INVALID_EXECUTION_NUMBER', 'رقم التنفيذ يجب أن يتكون من 11 رقماً', req.correlationId);
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

        const empQuery = { _id: userId };
        if (req.tenant) empQuery.tenantId = req.tenant._id;
        const employeeRecord = await Employee.findOne(empQuery).populate('groupId');
        const emp = executorWithSessionGroup(employeeRecord, req.user.executorGroupId);
        if (!emp) {
            return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        }
        if (emp.role === 'accountant') {
            return sendMobileError(res, 403, 'TASKS_FORBIDDEN', 'صلاحيات المحاسب لا تسمح بتنفيذ العمليات', req.correlationId);
        }

        const tx = await findOwnedAcceptedExecutorTask({
            transactionId: req.params.id,
            executor: emp,
            tenantId: req.tenant ? executorTenantScope(req) : null
        });
        if (!tx) {
            return sendMobileError(res, 409, 'INVALID_STATE', 'الطلب غير متاح للإنهاء', req.correlationId);
        }
        let senderEntries;
        try {
            senderEntries = normalizeExecutorSenderEntries({
                requestedSenderEntries,
                senderPhone,
                operationAmount: tx.amount,
                group: emp.groupId
            });
        } catch (error) {
            if (error instanceof ExecutorSenderEntriesError) {
                return sendMobileError(res, error.statusCode, error.code, error.message, req.correlationId);
            }
            throw error;
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

        const uploadedImages = Array.isArray(imagesBase64) && imagesBase64.length
            ? imagesBase64
            : (imageBase64 ? [imageBase64] : []);
        if (uploadedImages.length > 5 || uploadedImages.some((image) => typeof image !== 'string')) {
            return sendMobileError(res, 400, 'INVALID_PROOF_IMAGES', 'يمكن إرفاق خمس صور إثبات كحد أقصى', req.correlationId);
        }
        const savedFileIds = uploadedImages.map((image, index) => (
            saveProofImage(image, `${tx.customId || tx._id}_executor_${index + 1}`)
        ));

        tx.status = 'completed';
        tx.proofImages = systemReceiptId ? [systemReceiptId] : [];
        tx.proofImage = systemReceiptId || undefined;
        tx.executorProofImages = savedFileIds;
        tx.executorExecutionNumber = executionNumber || undefined;
        tx.executorSenderPhone = senderEntries[0]?.phone || undefined;
        tx.executorSenderEntries = senderEntries;
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
                hasProofImage: savedFileIds.length > 0,
                proofCount: tx.proofImages.length,
                executorProofCount: savedFileIds.length,
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

        const evidenceSource = String(req.query.source || '').trim().toLowerCase();
        let photoId;
        if (evidenceSource === 'executor') {
            const employee = await Employee.findById(userId).lean();
            if (accountType !== 'executor' || employee?.role !== 'manager') {
                return sendMobileError(res, 403, 'FORBIDDEN', 'صور إثبات المنفذ متاحة للمدير فقط', req.correlationId);
            }
            const evidenceIndex = Math.max(0, Number.parseInt(req.query.index, 10) || 0);
            photoId = Array.isArray(tx.executorProofImages) ? tx.executorProofImages[evidenceIndex] : null;
        } else {
            photoId = tx.proofImages && tx.proofImages.length > 0 ? tx.proofImages[0] : tx.proofImage;
        }
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
        const text = typeof req.body.text === 'string' ? req.body.text : req.body.message;
        const subject = String(req.body.subject || '').trim();
        const category = String(req.body.category || 'general').trim() || 'general';
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
        } else if (accountType === 'sub_client') {
            const account = await SubAccount.findById(userId);
            if (account) { name = account.name; phone = account.phone; }
        } else if (accountType === 'agent_staff') {
            const emp = await AgentEmployee.findById(userId);
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
            metadata: {
                subject: subject.slice(0, 120),
                category: category.slice(0, 40)
            },
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
                subject: ticket.metadata?.subject || '',
                category: ticket.metadata?.category || 'general',
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
                subject: t.metadata?.subject || '',
                category: t.metadata?.category || 'general',
                lastMessage: t.messages?.length ? t.messages[t.messages.length - 1].text || '' : '',
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
                subject: ticket.metadata?.subject || '',
                category: ticket.metadata?.category || 'general',
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
            transactions: txs.map(tx => {
                const hasOfficialReceipt = Boolean(
                    tx.proofImage || (tx.proofImages && tx.proofImages.length > 0)
                );
                return {
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
                    cancellationNumber: tx.cancellationNumber || null,
                    cancellationReason: tx.cancellationReason || null,
                    hasProofImage: hasOfficialReceipt,
                    receiptUrl: hasOfficialReceipt
                        ? createReceiptImageUrl({ transactionId: tx._id, index: 0 })
                        : null
                };
            }),
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
        if (!['client_user', 'client_company', 'sub_client', 'agent_staff', 'executor'].includes(accountType)) {
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
            audience: { $in: accountType === 'executor' ? ['executor', 'all'] : ['client', 'all'] }
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
        if (!['client_user', 'client_company', 'sub_client', 'agent_staff', 'executor'].includes(accountType)) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        const userIds = await resolveClientNotificationUserIds({ accountType, clientId: userId });
        if (!userIds.length) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الإشعار غير موجود', req.correlationId);
        }

        const result = await Notification.updateOne({
            _id: req.params.id,
            userId: { $in: userIds },
            audience: { $in: accountType === 'executor' ? ['executor', 'all'] : ['client', 'all'] }
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
                cancellationNumber: tx.cancellationNumber || null,
                cancellationReason: tx.cancellationReason || null,
                hasProofImage: !!(tx.proofImage || (tx.proofImages && tx.proofImages.length > 0)),
                // Keep the detail response consistent with the transaction list.
                // This is also the official cancellation receipt when the operation
                // was rejected or cancelled by the administration.
                receiptUrl: (tx.proofImage || (tx.proofImages && tx.proofImages.length > 0))
                    ? createReceiptImageUrl({ transactionId: tx._id, index: 0 })
                    : null
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء جلب تفاصيل العملية');
    }
});

// Authenticated receipt fallback for mobile clients. The public signed URL is
// useful for sharing, but the app must still be able to display a receipt when
// PUBLIC_APP_URL or RECEIPT_SHARE_SECRET is not configured on the server.
router.get('/client/transactions/:id/receipt', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        const index = Math.max(0, Number.parseInt(req.query.index, 10) || 0);
        const tx = req.tenant
            ? await Transaction.findOne({ _id: req.params.id, tenantId: req.tenant._id }).lean()
            : await Transaction.findById(req.params.id).lean();

        if (!tx) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'العملية غير موجودة', req.correlationId);
        }

        let hasAccess = false;
        if (accountType === 'client_user') {
            const user = await User.findById(userId).lean();
            const allowedIds = user
                ? [user.phone, user.webUsername, String(user._id)].filter(Boolean).map(String)
                : [];
            hasAccess = allowedIds.includes(String(tx.userId));
        } else if (accountType === 'client_company') {
            const employee = await ClientEmployee.findById(userId).lean();
            hasAccess = Boolean(
                employee && tx.companyId && String(tx.companyId) === String(employee.companyId)
            );
        } else if (accountType === 'agent_staff') {
            const agentQuery = await buildAgentStaffTransactionQuery(userId);
            if (agentQuery) {
                hasAccess = Boolean(await Transaction.exists({ _id: tx._id, ...agentQuery }));
            }
        }

        if (!hasAccess) {
            return sendMobileError(res, 403, 'FORBIDDEN', 'غير مصرح لك بعرض إيصال هذه العملية', req.correlationId);
        }

        if (!['completed', 'cancelled', 'canceled', 'cancelled_by_admin', 'rejected', 'failed'].includes(tx.status)) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'الإيصال غير متاح قبل اكتمال العملية', req.correlationId);
        }

        const photoId = getClientReceiptProofIds(tx)[index];
        if (!photoId) {
            return sendMobileError(res, 404, 'NOT_FOUND', 'صورة الإيصال غير متاحة', req.correlationId);
        }

        res.setHeader('X-Robots-Tag', 'noindex, noarchive, nosnippet');
        res.setHeader('Content-Disposition', 'inline; filename="receipt.jpg"');
        await streamProofImage(proofSourceUrl(photoId), res);
    } catch (e) {
        return sendServerError(res, req, 'تعذر تحميل إيصال العملية');
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
        eventBus.publish('executor:report-ready', {
            employeeId: String(req.user.userId),
            dateType: dateType === 'month' ? 'month' : 'day',
            dateValue: String(dateValue || '')
        });
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
router.post('/client/balance-transfer', authenticateJWT, requireOperationPin, requireIdempotencyKey, balanceTransferValidator, async (req, res) => {
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

// Executor support workspace. The legacy single-conversation endpoints below
// remain available for older mobile releases.
router.get('/executor/support/tickets', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الصفحة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const result = await executorSupportService.listExecutorTickets({
            executorId: req.user.userId,
            status: req.query.status,
            category: req.query.category,
            search: req.query.search,
            page: req.query.page,
            limit: req.query.limit
        });
        return res.json({ success: true, ...result, serverTime: new Date().toISOString() });
    } catch (error) {
        return sendExecutorSupportError(res, req, error, 'حدث خطأ أثناء جلب طلبات الدعم.');
    }
});

// One persistent internal group per executor company. Membership is derived
// from active company employees, so removed employees immediately lose access.
router.get('/executor/support/group-chat', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الصفحة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const workspace = await executorSupportService.getExecutorGroupChat({ executorId: req.user.userId });
        return res.json({ success: true, ...workspace, serverTime: new Date().toISOString() });
    } catch (error) {
        return sendExecutorSupportError(res, req, error, 'تعذر فتح مجموعة شركة التنفيذ.');
    }
});

router.post('/executor/support/group-chat/replies', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الصفحة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const workspace = await executorSupportService.replyToExecutorGroupChat({
            executorId: req.user.userId,
            payload: req.body
        });
        req.app.get('io')?.emit('support:ticket-updated', {
            ticketId: workspace.ticket.id,
            channel: 'portal',
            direction: 'inbound',
            status: workspace.ticket.status,
            source: 'executor_group_chat'
        });
        return res.json({ success: true, ...workspace, serverTime: new Date().toISOString() });
    } catch (error) {
        return sendExecutorSupportError(res, req, error, 'تعذر إرسال رسالة المجموعة.');
    }
});

router.post('/executor/support/tickets', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الصفحة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const ticket = await executorSupportService.createExecutorTicket({
            executorId: req.user.userId,
            payload: req.body
        });
        req.app.get('io')?.emit('support:ticket-updated', {
            ticketId: ticket.id,
            channel: 'portal',
            direction: 'inbound',
            status: ticket.status,
            source: 'executor_app'
        });
        return res.status(201).json({ success: true, ticket, serverTime: new Date().toISOString() });
    } catch (error) {
        return sendExecutorSupportError(res, req, error, 'حدث خطأ أثناء إنشاء طلب الدعم.');
    }
});

router.get('/executor/support/diagnostics', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الصفحة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const diagnostics = await executorSupportService.getExecutorDiagnostics({
            executorId: req.user.userId
        });
        return res.json({ success: true, diagnostics });
    } catch (error) {
        return sendExecutorSupportError(res, req, error, 'تعذر تشغيل فحص الاتصال حالياً.');
    }
});

router.get('/executor/support/tickets/:id', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الصفحة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const ticket = await executorSupportService.getExecutorTicket({
            executorId: req.user.userId,
            ticketId: req.params.id
        });
        return res.json({ success: true, ticket, serverTime: new Date().toISOString() });
    } catch (error) {
        return sendExecutorSupportError(res, req, error, 'حدث خطأ أثناء جلب تفاصيل طلب الدعم.');
    }
});

router.post('/executor/support/tickets/:id/replies', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'هذه الصفحة مخصصة لحسابات التنفيذ.', req.correlationId);
        }
        const ticket = await executorSupportService.replyToExecutorTicket({
            executorId: req.user.userId,
            ticketId: req.params.id,
            payload: req.body
        });
        req.app.get('io')?.emit('support:ticket-updated', {
            ticketId: ticket.id,
            channel: 'portal',
            direction: 'inbound',
            status: ticket.status,
            source: 'executor_app'
        });
        return res.json({ success: true, ticket, serverTime: new Date().toISOString() });
    } catch (error) {
        return sendExecutorSupportError(res, req, error, 'حدث خطأ أثناء إرسال الرد إلى الدعم.');
    }
});

// Legacy executor support messages.
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
router.get('/executor/deposits', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        // Older executor accounts were created before tenantId was stored on
        // Employee. The authenticated employee id is already signed in the
        // JWT, so resolve it directly instead of returning a misleading 404
        // for those existing production accounts.
        const employee = await Employee.findById(req.user.userId).populate('groupId');
        if (!employee) return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        const requests = await executorDepositRequestService.listDepositRequests({ employee });
        return res.json({ success: true, requests, serverTime: new Date().toISOString() });
    } catch (error) {
        return sendMobileError(res, error.status || 500, error.status === 401 ? 'UNAUTHORIZED' : 'DEPOSIT_LIST_FAILED', error.message || 'تعذر تحميل طلبات الإيداع.', req.correlationId);
    }
});

// The account holder may create the PIN once from settings. Subsequent PIN
// resets are restricted to the security administrators.
router.get('/security/operation-pin/status', authenticateJWT, async (req, res) => {
    try {
        return res.json({ success: true, ...(await operationPinService.status(operationPinService.principalFromUser(req.user))) });
    } catch (_) {
        return sendServerError(res, req, 'تعذر تحميل حالة رمز العمليات');
    }
});

router.post('/security/operation-pin/setup', authenticateJWT, mfaMiddleware, async (req, res) => {
    try {
        const profile = await operationPinService.setupInitialPin({
            principal: operationPinService.principalFromUser(req.user),
            pin: req.body?.pin,
            createdBy: req.user.name || req.user.webUsername || String(req.user.userId)
        });
        return res.json({ success: true, ...profile, message: 'تم تفعيل رمز العمليات. لتغييره أو إلغائه تواصل مع الإدارة.' });
    } catch (error) {
        const message = error.code === 'OPERATION_PIN_ADMIN_ONLY'
            ? 'تم إنشاء الرمز سابقاً؛ تغييره متاح للإدارة فقط.'
            : 'يجب أن يتكون رمز العمليات من 4 إلى 6 أرقام.';
        return sendMobileError(res, 422, error.code || 'OPERATION_PIN_SETUP_FAILED', message, req.correlationId);
    }
});

router.post('/executor/deposits/:id/review', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        const decision = String(req.body?.decision || '');
        if (!['approve', 'reject'].includes(decision)) return sendMobileError(res, 422, 'INVALID_DECISION', 'قرار المراجعة غير صالح.', req.correlationId);
        const employee = await Employee.findById(req.user.userId).populate('groupId');
        if (!employee) return sendMobileError(res, 404, 'EMPLOYEE_NOT_FOUND', 'لم يتم العثور على حساب المنفذ', req.correlationId);
        const result = await executorDepositRequestService.reviewAdminDepositRequest({
            employee,
            requestId: req.params.id,
            approved: decision === 'approve',
            reason: req.body?.reason
        });
        return res.json({ success: true, status: decision === 'approve' ? 'approved' : 'rejected', requestId: String(result.transaction._id) });
    } catch (error) {
        return sendMobileError(res, error.status || 500, error.status === 403 ? 'FORBIDDEN' : 'DEPOSIT_REVIEW_FAILED', error.message || 'تعذر حفظ قرار الإيداع.', req.correlationId);
    }
});

router.get('/executor/overview', authenticateJWT, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }
        const result = await mobileWebParityService.getExecutorOverview({
            executorId: req.user.userId,
            tenantId: req.tenant ? executorTenantScope(req) : null
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
        const { dateType, dateValue, dateFrom, dateTo, employeeId } = req.body;
        
        const result = await mobileWebParityService.getExecutorReports({
            executorId: userId,
            dateType,
            dateValue,
            dateFrom,
            dateTo,
            employeeId,
            tenantId: req.tenant ? executorTenantScope(req) : null
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
        if (e.message === 'INVALID_PERIOD') {
            return sendMobileError(res, 422, 'INVALID_PERIOD', 'الفترة غير صالحة أو تتجاوز سنة واحدة', req.correlationId);
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
        const { dateType, dateValue, dateFrom, dateTo, employeeId } = req.body;
        await mobileWebParityService.getExecutorReports({
            executorId: req.user.userId,
            dateType,
            dateValue,
            dateFrom,
            dateTo,
            employeeId,
            tenantId: req.tenant ? executorTenantScope(req) : null
        });

        const token = createReportDownloadToken({
            executorId: String(req.user.userId),
            dateType: ['month', 'range'].includes(dateType) ? dateType : 'day',
            dateValue: String(dateValue || ''),
            dateFrom: dateFrom ? String(dateFrom) : null,
            dateTo: dateTo ? String(dateTo) : null,
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
        if (e.message === 'INVALID_PERIOD') {
            return sendMobileError(res, 422, 'INVALID_PERIOD', 'الفترة غير صالحة أو تتجاوز سنة واحدة', req.correlationId);
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
            dateFrom: payload.dateFrom,
            dateTo: payload.dateTo,
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
        const workspace = await mobileWebParityService.getEmployeesWorkspace({
            executorId: userId,
            tenantId: req.tenant ? executorTenantScope(req) : null
        });
        return res.json({
            success: true,
            employees: workspace.employees.map(emp => mobileWebParityMapper.toEmployeeDto(emp)),
            summary: workspace.summary
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
            message: 'تمت أرشفة الموظف مع الاحتفاظ بسجل عملياته'
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
