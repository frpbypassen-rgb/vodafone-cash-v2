const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const Ledger = require('../models/Ledger');
const RegistrationRequest = require('../models/RegistrationRequest');
const SupportTicket = require('../models/SupportTicket');

const { authenticateJWT } = require('../middlewares/jwtAuth');
const correlationId = require('../middlewares/correlationId');
const requireIdempotencyKey = require('../middlewares/requireIdempotencyKey');
const { logAction } = require('../services/auditService');
const { proofSourceUrl, saveProofImage, streamProofImage } = require('../services/proofStorageService');
const authController = require('../controllers/auth/authController');
const transferService = require('../services/transferService');
const { deviceTrustMiddleware } = require('../src/Presentation/Middlewares/deviceTrustMiddleware');
const { mfaMiddleware } = require('../src/Presentation/Middlewares/mfaMiddleware');
const { getRateForTier } = require('../utils/rateHelper');
const {
    loginValidator,
    refreshTokenValidator,
    transferValidator,
    cancelTaskValidator,
    completeTaskValidator
} = require('../validators/mobileValidators');
const {
    directRegisterValidator,
    newRegisterValidator,
    companyRegisterValidator,
    agentRegisterValidator
} = require('../validators/mobileRegistrationValidators');
const { sendMobileError, mobileErrorHandler } = require('../mappers/mobileErrorMapper');

const router = express.Router();

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
const checkRegistrationUniqueness = async (phone, username) => {
    const pendingRequest = await RegistrationRequest.findOne({ phone, status: 'pending' });
    if (pendingRequest) {
        return {
            success: false,
            message: `يوجد طلب تسجيل سابق لهذا الرقم برقم مرجعي: ${pendingRequest.refCode}. يرجى انتظار المراجعة.`
        };
    }

    const user = await User.findOne({ $or: [{ phone }, { webUsername: username }] });
    if (user) {
        return {
            success: false,
            message: 'رقم الهاتف أو اسم المستخدم مسجل بالفعل. يرجى تسجيل الدخول أو التواصل مع الإدارة.'
        };
    }

    const clientEmp = await ClientEmployee.findOne({ $or: [{ phone }, { webUsername: username }] });
    if (clientEmp) {
        return {
            success: false,
            message: 'رقم الهاتف أو اسم المستخدم مسجل بالفعل. يرجى تسجيل الدخول أو التواصل مع الإدارة.'
        };
    }

    const emp = await Employee.findOne({ $or: [{ phone }, { webUsername: username }] });
    if (emp) {
        return {
            success: false,
            message: 'رقم الهاتف أو اسم المستخدم مسجل بالفعل. يرجى تسجيل الدخول أو التواصل مع الإدارة.'
        };
    }

    return { success: true };
};

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
        let { fullName, phone, storeName, address, username, password, agentCode } = req.body;
        if (username && !username.includes('@')) username += '@ahram.com';

        const agent = await User.findOne({ agentCode, role: 'agent', status: 'active' });
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
            storeName,
            address,
            username,
            password,
            agentCode,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown',
            status: 'pending'
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedByName: fullName || username || 'unknown',
            result: 'معلق',
            metadata: { accountType: 'new', phone, regRequestId: regRequest._id, agentCode }
        });

        return res.status(200).json({
            success: true,
            message: 'تم تقديم طلب التسجيل بنجاح، وهو قيد المراجعة من قبل الإدارة',
            data: {
                refCode: regRequest.refCode,
                accountType: 'new',
                fullName: regRequest.fullName,
                phone: regRequest.phone,
                storeName: regRequest.storeName,
                address: regRequest.address,
                username: regRequest.username,
                agentCode: regRequest.agentCode,
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

        let agentCode;
        let codeExists = true;
        while (codeExists) {
            agentCode = Math.floor(10000000 + Math.random() * 90000000).toString();
            const checkReq = await RegistrationRequest.findOne({ agentCode });
            if (!checkReq) codeExists = false;
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
            agentCode,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown',
            status: 'pending'
        });

        await logAction({
            action: 'USER_CREATED',
            req,
            performedByName: fullName || username || 'unknown',
            result: 'معلق',
            metadata: { accountType: 'agent', phone, regRequestId: regRequest._id, agentCode }
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
                agentCode: regRequest.agentCode,
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
router.get('/client/home', authenticateJWT, async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        if (accountType === 'executor') {
            return sendMobileError(res, 403, 'FORBIDDEN', 'صلاحيات غير كافية', req.correlationId);
        }

        let balance = 0;
        let tier = 1;

        if (accountType === 'client_company') {
            const emp = await ClientEmployee.findById(userId);
            if (emp) {
                const company = await ClientCompany.findById(emp.companyId);
                if (company) {
                    balance = company.balance || 0;
                    tier = company.tier || 1;
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
        }

        const settings = await Settings.findOne({});
        const exchangeRate = getRateForTier(tier, settings);
        return res.json({
            success: true,
            balance: Number(balance),
            exchangeRate: Number(exchangeRate),
            isOpen: !(settings && settings.isManualClosed),
            serverTime: new Date().toISOString()
        });
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
        let balance = 0;
        let tier = 1;

        if (accountType === 'client_company') {
            const emp = await ClientEmployee.findById(userId);
            if (emp) {
                const company = await ClientCompany.findById(emp.companyId);
                if (company) {
                    balance = company.balance || 0;
                    tier = company.tier || 1;
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
        }

        return res.json({
            success: true,
            balance: Number(balance),
            exchangeRate: Number(getRateForTier(tier, settings)),
            isOpen: !(settings && settings.isManualClosed),
            serverTime: new Date().toISOString()
        });
    } catch (e) {
        return sendServerError(res, req, 'خطأ داخلي بالسيرفر');
    }
});

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
        tx.notes = (tx.notes ? `${tx.notes}\n` : '') + `[تم الإلغاء | المنفذ: ${emp.name} | السبب: ${reason}]`;
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
                recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
                recipientName: tx.accountName || null,
                amount: Number(tx.amount || 0),
                costLYD: Number(tx.costLYD || 0),
                exchangeRate: Number(tx.exchangeRate || 0),
                status: tx.status,
                createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
                notes: tx.notes || null,
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
                recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
                recipientName: tx.accountName || null,
                amount: Number(tx.amount || 0),
                costLYD: Number(tx.costLYD || 0),
                exchangeRate: Number(tx.exchangeRate || 0),
                status: tx.status,
                createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
                notes: tx.notes || null,
                hasProofImage: !!(tx.proofImage || (tx.proofImages && tx.proofImages.length > 0))
            }
        });
    } catch (e) {
        return sendServerError(res, req, 'حدث خطأ أثناء جلب تفاصيل العملية');
    }
});

router.use((req, res) => {
    return sendMobileError(res, 404, 'NOT_FOUND', 'المورد غير موجود', req.correlationId);
});

router.use(mobileErrorHandler);

module.exports = router;
