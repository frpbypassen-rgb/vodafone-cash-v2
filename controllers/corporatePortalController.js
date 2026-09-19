'use strict';

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const ClientEmployee = require('../models/ClientEmployee');
const CorporateBeneficiary = require('../models/CorporateBeneficiary');
const CorporatePaymentRequest = require('../models/CorporatePaymentRequest');
const CorporateInvoice = require('../models/CorporateInvoice');
const AuditLog = require('../models/AuditLog');
const { detectCorporateView } = require('../middlewares/corporateAuth');
const { ROLE_LABELS } = require('../services/corporateRoleService');
const { logAction } = require('../services/auditService');
const approvalService = require('../services/corporateApprovalService');
const reportService = require('../services/corporateReportService');
const insightService = require('../services/corporateInsightService');
const { assignCorporateRole } = require('../services/corporateOnboardingService');
const passkeyService = require('../services/passkeyService');
const SecurityDevice = require('../models/SecurityDevice');
const { issueStepUpTicket } = require('../middlewares/corporateStepUp');

const sendError = (res, error) => {
    const status = error.statusCode || 400;
    return res.status(status).json({
        success: false,
        code: error.code || 'CORPORATE_ERROR',
        error: error.message || 'تعذر تنفيذ العملية.'
    });
};

const publicBeneficiary = (doc, includeFull = false) => {
    if (typeof doc.toPublicJSON === 'function') return doc.toPublicJSON({ includeFullAccount: includeFull });
    return {
        id: String(doc._id),
        name: doc.name,
        serviceType: doc.serviceType,
        accountNumberLast4: doc.accountNumberLast4,
        status: doc.status,
        notes: doc.notes || '',
        createdByName: doc.createdByName || '',
        createdAt: doc.createdAt
    };
};

const loadDashboardData = async (context) => {
    const requestFilter = reportService.scopedFilter(context);
    const [requests, beneficiaries, staff, invoices] = await Promise.all([
        CorporatePaymentRequest.find(requestFilter).sort({ createdAt: -1 }).limit(80).lean(),
        CorporateBeneficiary.find({ companyId: context.companyId }).sort({ createdAt: -1 }).limit(80).lean(),
        context.permissions.canViewStaff
            ? ClientEmployee.find({ companyId: context.companyId, status: { $ne: 'deleted' } })
                .select('name phone webUsername role corporateRole approvalLimit corporatePortalEnabled status')
                .sort({ name: 1 })
                .lean()
            : Promise.resolve([]),
        context.permissions.canUploadInvoices || context.role === 'accountant'
            ? CorporateInvoice.find({ companyId: context.companyId }).sort({ createdAt: -1 }).limit(40).lean()
            : Promise.resolve([])
    ]);

    const pending = requests.filter((item) => item.status === 'pending_approval');
    const kpis = reportService.summarizeDashboard(requests, context.company, context.role);
    const insights = await insightService.buildInsights(context, requests);

    return {
        requests: requests.map((item) => approvalService.toPublicRequest(item)),
        pending: pending.map((item) => approvalService.toPublicRequest(item)),
        beneficiaries: beneficiaries.map((item) => publicBeneficiary(item)),
        staff: staff.map((item) => ({
            id: String(item._id),
            name: item.name,
            webUsername: item.webUsername,
            role: item.corporateRole || item.role,
            approvalLimit: item.approvalLimit,
            corporatePortalEnabled: item.corporatePortalEnabled !== false,
            status: item.status
        })),
        invoices: invoices.map((item) => ({
            id: String(item._id),
            originalName: item.originalName,
            vendorName: item.vendorName,
            amount: item.amount,
            matchStatus: item.matchStatus,
            createdAt: item.createdAt
        })),
        kpis,
        insights
    };
};

const buildPageLocals = async (req, activeTab = 'home') => {
    const context = req.corporate;
    const view = detectCorporateView(req);
    const data = await loadDashboardData(context);
    const branding = context.profile?.brandingName
        || context.company.corporatePortal?.brandingName
        || context.company.name;

    return {
        title: 'بوابة الشركات',
        view,
        activeTab,
        csrfToken: req.session.csrfToken || '',
        branding,
        companyName: context.company.name,
        actorName: context.actor.name,
        role: context.role,
        roleLabel: ROLE_LABELS[context.role],
        permissions: context.permissions,
        approvalLimit: context.approvalLimit,
        balance: context.permissions.canViewAllOps ? Number(context.company.balance || 0) : null,
        creditLimit: context.permissions.canViewAllOps ? Number(context.company.creditLimit || 0) : null,
        sharedDailyLimit: Number(context.profile?.sharedDailyLimit || context.company.corporatePortal?.sharedDailyLimit || 0),
        bootstrap: {
            role: context.role,
            roleLabel: ROLE_LABELS[context.role],
            permissions: context.permissions,
            approvalLimit: context.approvalLimit,
            csrfToken: req.session.csrfToken || '',
            view,
            activeTab,
            branding,
            actorName: context.actor.name,
            companyName: context.company.name,
            balance: context.permissions.canViewAllOps ? Number(context.company.balance || 0) : null,
            ...data
        }
    };
};

exports.renderPortal = async (req, res, next) => {
    try {
        const tab = String(req.params.tab || req.query.tab || 'home');
        const locals = await buildPageLocals(req, tab);
        const template = locals.view === 'mobile'
            ? 'corporate/dashboard-mobile'
            : 'corporate/dashboard-desktop';
        return res.render(template, locals);
    } catch (error) {
        return next(error);
    }
};

exports.getMe = async (req, res) => {
    const { actor, role, permissions, approvalLimit, company } = req.corporate;
    return res.json({
        success: true,
        actor: {
            id: String(actor._id),
            name: actor.name,
            role,
            approvalLimit,
            permissions
        },
        company: {
            id: String(company._id),
            name: company.name,
            balance: permissions.canViewAllOps ? Number(company.balance || 0) : null
        }
    });
};

exports.getDashboard = async (req, res) => {
    try {
        const data = await loadDashboardData(req.corporate);
        return res.json({ success: true, ...data, role: req.corporate.role, approvalLimit: req.corporate.approvalLimit });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.listBeneficiaries = async (req, res) => {
    const query = CorporateBeneficiary.find({ companyId: req.corporate.companyId }).sort({ createdAt: -1 });
    if (req.corporate.role === 'manager') query.select('+accountNumberEncrypted');
    const items = await query;
    return res.json({ success: true, beneficiaries: items.map((item) => publicBeneficiary(item, req.corporate.role === 'manager')) });
};

exports.createBeneficiary = async (req, res) => {
    try {
        if (!req.corporate.permissions.canAddBeneficiaries) {
            return res.status(403).json({ success: false, code: 'CORPORATE_FORBIDDEN', error: 'إضافة المستفيدين متاحة للمدير فقط.' });
        }
        const name = String(req.body.name || '').trim();
        const accountNumber = String(req.body.accountNumber || '').trim();
        const serviceType = String(req.body.serviceType || 'vodafone').trim();
        if (!name || !accountNumber) {
            return res.status(400).json({ success: false, code: 'INVALID_BENEFICIARY', error: 'الاسم ورقم الحساب مطلوبان.' });
        }
        const encrypted = CorporateBeneficiary.encryptAccountNumber(accountNumber);
        const created = await CorporateBeneficiary.create({
            companyId: req.corporate.companyId,
            tenantId: req.corporate.tenantId,
            name,
            serviceType,
            notes: String(req.body.notes || '').trim().slice(0, 500),
            createdById: req.corporate.actor._id,
            createdByName: req.corporate.actor.name,
            ...encrypted
        });
        await logAction({
            action: 'CORPORATE_BENEFICIARY_ADDED',
            req,
            performedById: req.corporate.actor._id,
            performedByModel: 'ClientEmployee',
            performedByName: req.corporate.actor.name,
            targetId: created._id,
            targetModel: 'CorporateBeneficiary',
            companyId: req.corporate.companyId,
            metadata: { companyId: String(req.corporate.companyId), name, serviceType }
        });
        return res.status(201).json({ success: true, beneficiary: publicBeneficiary(created) });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.updateBeneficiary = async (req, res) => {
    try {
        if (!req.corporate.permissions.canAddBeneficiaries) {
            return res.status(403).json({ success: false, code: 'CORPORATE_FORBIDDEN', error: 'تعديل المستفيدين متاح للمدير فقط.' });
        }
        const beneficiary = await CorporateBeneficiary.findOne({
            _id: req.params.id,
            companyId: req.corporate.companyId
        });
        if (!beneficiary) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'المستفيد غير موجود.' });
        if (req.body.status && ['approved', 'disabled'].includes(req.body.status)) {
            beneficiary.status = req.body.status;
        }
        if (req.body.name) beneficiary.name = String(req.body.name).trim();
        if (req.body.notes !== undefined) beneficiary.notes = String(req.body.notes || '').trim().slice(0, 500);
        if (req.body.accountNumber) {
            Object.assign(beneficiary, CorporateBeneficiary.encryptAccountNumber(req.body.accountNumber));
        }
        await beneficiary.save();
        return res.json({ success: true, beneficiary: publicBeneficiary(beneficiary) });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.listRequests = async (req, res) => {
    const items = await reportService.loadOperations(req.corporate, req.query);
    return res.json({ success: true, requests: items.map((item) => approvalService.toPublicRequest(item)) });
};

exports.createPaymentRequest = async (req, res) => {
    try {
        const result = await approvalService.createRequest({
            context: req.corporate,
            payload: req.body || {},
            req
        });
        return res.status(result.created ? 201 : 200).json({ success: true, ...result });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.approveRequest = async (req, res) => {
    try {
        const result = await approvalService.decideRequest({
            context: req.corporate,
            requestId: req.params.id,
            decision: 'approve',
            req
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.rejectRequest = async (req, res) => {
    try {
        const result = await approvalService.decideRequest({
            context: req.corporate,
            requestId: req.params.id,
            decision: 'reject',
            reason: req.body?.reason,
            req
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.retryExecute = async (req, res) => {
    try {
        const result = await approvalService.retryExecution({
            context: req.corporate,
            requestId: req.params.id,
            req
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.addRequestNote = async (req, res) => {
    try {
        const result = await approvalService.addAuditNote({
            context: req.corporate,
            requestId: req.params.id,
            body: req.body?.body || req.body?.note,
            req
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.reconcileRequest = async (req, res) => {
    try {
        const result = await approvalService.reconcileRequest({
            context: req.corporate,
            requestId: req.params.id,
            req
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.listStaff = async (req, res) => {
    if (!req.corporate.permissions.canViewStaff) {
        return res.status(403).json({ success: false, code: 'CORPORATE_FORBIDDEN', error: 'عرض الفريق غير متاح لدورك.' });
    }
    const staff = await ClientEmployee.find({ companyId: req.corporate.companyId, status: { $ne: 'deleted' } })
        .select('name phone webUsername role corporateRole approvalLimit corporatePortalEnabled status')
        .sort({ name: 1 })
        .lean();
    return res.json({
        success: true,
        staff: staff.map((item) => ({
            id: String(item._id),
            name: item.name,
            webUsername: item.webUsername,
            role: item.corporateRole || item.role,
            approvalLimit: item.approvalLimit,
            corporatePortalEnabled: item.corporatePortalEnabled !== false,
            status: item.status
        }))
    });
};

exports.assignStaff = async (req, res) => {
    try {
        if (!req.corporate.permissions.canAssignPermissions) {
            return res.status(403).json({ success: false, code: 'CORPORATE_FORBIDDEN', error: 'تعيين الصلاحيات متاح للمدير فقط.' });
        }
        const employee = await assignCorporateRole({
            employeeId: req.params.id,
            companyId: req.corporate.companyId,
            corporateRole: String(req.body.corporateRole || '').trim(),
            approvalLimit: req.body.approvalLimit,
            enabled: req.body.corporatePortalEnabled !== false
        });
        await logAction({
            action: 'CORPORATE_STAFF_ASSIGNED',
            req,
            performedById: req.corporate.actor._id,
            performedByModel: 'ClientEmployee',
            performedByName: req.corporate.actor.name,
            targetId: employee._id,
            targetModel: 'ClientEmployee',
            companyId: req.corporate.companyId,
            metadata: {
                companyId: String(req.corporate.companyId),
                corporateRole: employee.corporateRole,
                approvalLimit: employee.approvalLimit
            }
        });
        return res.json({
            success: true,
            staff: {
                id: String(employee._id),
                name: employee.name,
                role: employee.corporateRole,
                approvalLimit: employee.approvalLimit,
                corporatePortalEnabled: employee.corporatePortalEnabled
            }
        });
    } catch (error) {
        return sendError(res, { ...error, message: error.message, statusCode: 400 });
    }
};

exports.exportReport = async (req, res) => {
    try {
        const exportPayload = await reportService.buildExportRows(req.corporate, req.query);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${exportPayload.filename}"`);
        return res.send(`\uFEFF${exportPayload.csv}`);
    } catch (error) {
        return sendError(res, error);
    }
};

exports.listAudit = async (req, res) => {
    if (!req.corporate.permissions.canViewAllOps) {
        return res.status(403).json({ success: false, code: 'CORPORATE_FORBIDDEN', error: 'سجل التدقيق غير متاح لدورك.' });
    }
    const logs = await AuditLog.find({ companyId: req.corporate.companyId })
        .sort({ createdAt: -1 })
        .limit(80)
        .lean();
    return res.json({
        success: true,
        logs: logs.map((item) => ({
            id: String(item._id),
            action: item.action,
            performedByName: item.performedByName,
            result: item.result,
            createdAt: item.createdAt,
            metadata: item.metadata || {}
        }))
    });
};

exports.getInsights = async (req, res) => {
    try {
        const requests = await CorporatePaymentRequest.find(reportService.scopedFilter(req.corporate))
            .sort({ createdAt: -1 })
            .limit(120)
            .lean();
        const insights = await insightService.buildInsights(req.corporate, requests);
        return res.json({ success: true, insights });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.parseOcr = async (req, res) => {
    try {
        const parsed = await insightService.parseInvoiceOcr({
            imageBase64: req.body?.imageBase64,
            mimeType: req.body?.mimeType,
            fileName: req.body?.fileName,
            hintAmount: req.body?.hintAmount,
            hintVendor: req.body?.hintVendor
        });
        return res.json({ success: true, ocr: parsed });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.uploadInvoice = async (req, res) => {
    try {
        if (!req.corporate.permissions.canUploadInvoices) {
            return res.status(403).json({ success: false, code: 'CORPORATE_FORBIDDEN', error: 'رفع الفواتير متاح للمحاسب فقط.' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, code: 'FILE_REQUIRED', error: 'ارفع ملف الفاتورة.' });
        }
        const invoice = await CorporateInvoice.create({
            companyId: req.corporate.companyId,
            tenantId: req.corporate.tenantId,
            originalName: req.file.originalname,
            storedName: req.file.filename,
            mimeType: req.file.mimetype,
            size: req.file.size,
            vendorName: String(req.body.vendorName || '').trim(),
            amount: req.body.amount ? Number(req.body.amount) : null,
            uploadedById: req.corporate.actor._id,
            uploadedByName: req.corporate.actor.name
        });
        return res.status(201).json({
            success: true,
            invoice: {
                id: String(invoice._id),
                originalName: invoice.originalName,
                vendorName: invoice.vendorName,
                amount: invoice.amount,
                matchStatus: invoice.matchStatus
            }
        });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.matchInvoice = async (req, res) => {
    try {
        if (!req.corporate.permissions.canUploadInvoices) {
            return res.status(403).json({ success: false, code: 'CORPORATE_FORBIDDEN', error: 'مطابقة الفواتير متاحة للمحاسب فقط.' });
        }
        const insights = await insightService.buildAccountantInsights(req.corporate);
        return res.json({ success: true, insights });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.confirmPassword = async (req, res) => {
    try {
        const password = String(req.body.password || req.body.pin || '').trim();
        if (password.length < 4) {
            return res.status(400).json({ success: false, code: 'PIN_REQUIRED', error: 'أدخل كلمة المرور أو رمز التأكيد.' });
        }
        const employee = await ClientEmployee.findById(req.corporate.actor._id).select('+webPassword');
        const ok = employee?.webPassword && await bcrypt.compare(password, employee.webPassword);
        if (!ok) {
            return res.status(403).json({ success: false, code: 'CONFIRM_FAILED', error: 'كلمة المرور غير صحيحة.' });
        }
        const stepUpToken = issueStepUpTicket(req);
        return res.json({ success: true, method: 'password', stepUpToken });
    } catch (error) {
        return sendError(res, error);
    }
};

exports.webauthnOptions = async (req, res) => {
    try {
        const devices = await SecurityDevice.find({
            principalType: 'client_company',
            principalId: String(req.corporate.actor._id),
            status: 'active',
            credentialId: { $exists: true, $ne: '' }
        }).lean();
        if (!devices.length) {
            return res.json({ success: true, available: false });
        }
        const options = await passkeyService.authenticationOptions({ req, devices });
        req.session.corporateWebauthnChallenge = options.challenge;
        return res.json({ success: true, available: true, options });
    } catch (_error) {
        return res.json({ success: true, available: false });
    }
};

exports.webauthnVerify = async (req, res) => {
    try {
        const expectedChallenge = req.session.corporateWebauthnChallenge;
        if (!expectedChallenge) {
            return res.status(400).json({ success: false, code: 'CHALLENGE_MISSING', error: 'أعد طلب التأكيد الحيوي.' });
        }
        const credentialId = req.body?.id || req.body?.rawId;
        const device = await SecurityDevice.findOne({
            principalType: 'client_company',
            principalId: String(req.corporate.actor._id),
            credentialId,
            status: 'active'
        });
        if (!device) {
            return res.status(403).json({ success: false, code: 'DEVICE_NOT_FOUND', error: 'لم يُعثر على مفتاح مرور لهذا الحساب.' });
        }
        await passkeyService.verifyAuthentication({
            req,
            response: req.body,
            expectedChallenge,
            device
        });
        delete req.session.corporateWebauthnChallenge;
        const stepUpToken = issueStepUpTicket(req);
        return res.json({ success: true, method: 'webauthn', stepUpToken });
    } catch (error) {
        return res.status(403).json({ success: false, code: 'WEBAUTHN_FAILED', error: error.message || 'فشل التأكيد الحيوي.' });
    }
};

exports.serviceWorker = (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/corporate');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(__dirname, '../public/js/corporate-sw.js'));
};

exports.ensureUploadDir = () => {
    const directory = path.join(__dirname, '../uploads/corporate');
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    return directory;
};
