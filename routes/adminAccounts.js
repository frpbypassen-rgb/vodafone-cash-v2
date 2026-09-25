'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { logAction } = require('../services/auditService');
const {
    findEditableAccount,
    findCompanyLoginOwner,
    updateEditableAccount,
    updateAccountOwnerEmailOtp,
    loadEditOptions,
    getReturnUrl,
    getErrorMessage
} = require('../services/adminAccountManagementService');
const { notifyAccountPhoneChanged } = require('../services/accountPhoneChangeNotificationService');
const { phoneLengthModeFromLengths } = require('../utils/executorManualPolicy');
const { getExecutorEnabledServiceKeys } = require('../utils/executorServiceCatalog');

const verifyMultipartCsrf = (req, res, next) => {
    const expected = String(req.session?.csrfToken || '');
    const submitted = String(req.body?._csrf || req.get('x-csrf-token') || '');
    if (!expected || !submitted) return res.status(403).json({ success: false, error: 'Invalid CSRF token' });
    const expectedBuffer = Buffer.from(expected);
    const submittedBuffer = Buffer.from(submitted);
    if (expectedBuffer.length !== submittedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, submittedBuffer)) {
        return res.status(403).json({ success: false, error: 'Invalid CSRF token' });
    }
    return next();
};

const accountDocumentUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, path.join(__dirname, '../uploads')),
        filename: (_req, file, callback) => {
            const extension = ({
                'image/jpeg': '.jpg',
                'image/png': '.png',
                'image/webp': '.webp',
                'application/pdf': '.pdf'
            })[file.mimetype] || '.bin';
            callback(null, `account-document-${crypto.randomUUID()}${extension}`);
        }
    }),
    limits: { fileSize: 7 * 1024 * 1024, files: 4 },
    fileFilter: (_req, file, callback) => {
        const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
        if (!allowed.has(file.mimetype)) return callback(new Error('INVALID_DOCUMENT_TYPE'));
        return callback(null, true);
    }
});

const hasExpectedSignature = (file) => {
    const header = Buffer.alloc(12);
    const descriptor = fs.openSync(file.path, 'r');
    try { fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
    if (file.mimetype === 'image/jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    if (file.mimetype === 'image/png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (file.mimetype === 'image/webp') return header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP';
    if (file.mimetype === 'application/pdf') return header.subarray(0, 5).toString() === '%PDF-';
    return false;
};

const verifyUploadedDocuments = (req, res, next) => {
    const files = Object.values(req.files || {}).flat();
    const invalid = files.find((file) => !hasExpectedSignature(file));
    if (!invalid) return next();
    files.forEach((file) => { try { fs.unlinkSync(file.path); } catch (_) {} });
    return res.status(422).send('محتوى أحد الملفات لا يطابق نوعه المعلن.');
};

const BOOLEAN_FIELDS = Object.freeze([
    'canViewAllReports',
    'canManageCompany',
    'canCreateCompanyStaff',
    'canManageAgent',
    'canCreateAgentStaff',
    'emailOtpEnabled',
    'inheritCompanyPolicy',
    'proofRequired',
    'sessionTtlEnabled'
]);

const isChecked = (value) => ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());

const accountToFormData = (account, submitted = null, extras = {}) => {
    const businessProfile = account.businessProfile?.toObject
        ? account.businessProfile.toObject()
        : { ...(account.businessProfile || {}) };
    const base = {
        name: account.name || '',
        phone: account.phone || '',
        webUsername: account.webUsername || '',
        status: account.status || '',
        role: account.role || '',
        tier: account.tier || 1,
        creditLimit: account.creditLimit || 0,
        accountCode: account.accountCode || '',
        customMargin: account.customMargin || 0,
        cardMargin: account.cardMargin || 0,
        companyId: String(account.companyId || ''),
        agentId: String(account.agentId || ''),
        groupId: String(account.groupId || ''),
        parentGroupId: String(account.parentGroupId || account.parentBotId || ''),
        serviceKey: account.serviceKey || 'vodafone',
        serviceKeys: getExecutorEnabledServiceKeys(account),
        telegramId: account.telegramId || '',
        apiUrl: account.apiUrl || '',
        apiUsername: account.apiUsername || '',
        apiServiceId: account.apiServiceId ?? 85,
        apiProviderId: account.apiProviderId ?? 16,
        apiFieldId: account.apiFieldId ?? 5488,
        apiMachineSerial: account.apiMachineSerial || 'XP1',
        contactName: businessProfile.contactName || '',
        email: businessProfile.email || account.email || '',
        ownerEmail: extras.companyOwner?.email || '',
        ownerName: extras.companyOwner?.name || '',
        ownerUsername: extras.companyOwner?.webUsername || '',
        hasCompanyOwner: Boolean(extras.companyOwner),
        emailOtpEnabled: extras.companyOwner
            ? extras.companyOwner.otpDeliveryChannel === 'email'
            : account.otpDeliveryChannel === 'email',
        city: businessProfile.city || '',
        address: businessProfile.address || '',
        registrationNumber: businessProfile.registrationNumber || '',
        canViewAllReports: Boolean(account.canViewAllReports),
        canManageCompany: Boolean(account.canManageCompany),
        canCreateCompanyStaff: Boolean(account.canCreateCompanyStaff),
        canManageAgent: Boolean(account.canManageAgent),
        canCreateAgentStaff: Boolean(account.canCreateAgentStaff),
        inheritCompanyPolicy: (() => {
            const override = account.executionPolicyOverride || {};
            const raw = override.toObject ? override.toObject() : override;
            return !raw || Object.keys(raw).filter((key) => raw[key] !== undefined).length === 0;
        })(),
        proofRequired: Boolean(account.executionPolicyOverride?.proofRequired),
        phoneLengthMode: phoneLengthModeFromLengths(account.executionPolicyOverride?.allowedPhoneLengths),
        maxConcurrentDevices: account.executionPolicyOverride?.maxConcurrentDevices || 1,
        sessionTtlEnabled: Boolean(account.executionPolicyOverride?.sessionTtlEnabled),
        sessionTtlHours: Math.max(1, Math.round(Number(account.executionPolicyOverride?.sessionTtlSeconds || 28800) / 3600)),
        newPassword: '',
        apiPassword: '',
        apiToken: ''
    };

    if (!submitted) return base;
    const merged = { ...base, ...submitted, newPassword: '', apiPassword: '', apiToken: '' };
    BOOLEAN_FIELDS.forEach((field) => { merged[field] = isChecked(submitted[field]); });
    if (submitted.enabledServices) {
        merged.serviceKeys = Array.isArray(submitted.enabledServices)
            ? submitted.enabledServices
            : [submitted.enabledServices];
    }
    return merged;
};

const activePageForType = (type) => {
    if (type === 'executor') return 'executors';
    if (type.includes('employee')) return 'employees';
    return 'clients';
};

const renderEditor = async (req, res, { error = '', submitted = null, statusCode = 200 } = {}) => {
    const { definition, account } = await findEditableAccount(req.params.type, req.params.id);
    const companyOwner = definition.type === 'company'
        ? await findCompanyLoginOwner(account._id)
        : null;
    const options = await loadEditOptions(definition.type, account);
    return res.status(statusCode).render('admin_account_edit', {
        account,
        accountType: definition.type,
        accountLabel: definition.label,
        formData: accountToFormData(account, submitted, { companyOwner }),
        options,
        returnUrl: getReturnUrl(definition.type, account),
        activePage: activePageForType(definition.type),
        error,
        query: req.query || {}
    });
};

const ownerOtpErrorCode = (error) => {
    if (error?.code === 'EMAIL_REQUIRED') return 'email_required';
    if (error?.code === 'EMAIL_INVALID' || error?.code === 'EMAIL_OTP_ADDRESS_INVALID') return 'invalid_email';
    if (error?.code === 'EMAIL_TAKEN') return 'email_taken';
    if (error?.code === 'COMPANY_OWNER_REQUIRED') return 'owner_missing';
    if (error?.code === 'ACCOUNT_NOT_FOUND' || error?.code === 'INVALID_ACCOUNT_ID') return 'notfound';
    return 'failed';
};

router.post('/admin/accounts/:type/:id/owner-otp', requireAuth, requireMaster, async (req, res) => {
    try {
        const result = await updateAccountOwnerEmailOtp({
            type: req.params.type,
            id: req.params.id,
            payload: req.body || {}
        });

        await logAction({
            action: 'ADMIN_ACCOUNT_UPDATED',
            req,
            performedById: req.session.adminId,
            performedByModel: 'Admin',
            performedByName: req.session.adminName || req.session.adminUsername || 'الإدارة',
            targetId: result.account._id,
            targetModel: result.definition.modelName,
            oldData: result.oldData,
            newData: result.newData,
            result: 'ناجح',
            metadata: {
                accountType: result.definition.type,
                accountLabel: result.definition.label,
                changedFields: result.changedFields,
                ownerEmailOtp: true
            }
        }).catch(() => {});

        const returnUrl = getReturnUrl(result.definition.type, result.account);
        const separator = returnUrl.includes('?') ? '&' : '?';
        return res.redirect(`${returnUrl}${separator}ownerOtpSaved=1`);
    } catch (error) {
        console.error('[admin-account/owner-otp] update failed:', error.message);
        try {
            const returnUrl = getReturnUrl(req.params.type, { _id: req.params.id });
            const separator = returnUrl.includes('?') ? '&' : '?';
            return res.redirect(`${returnUrl}${separator}ownerOtpError=${ownerOtpErrorCode(error)}`);
        } catch (_) {
            return res.redirect('/clients?editError=failed');
        }
    }
});

router.get('/admin/accounts/:type/:id/edit', requireAuth, requireMaster, async (req, res) => {
    try {
        return await renderEditor(req, res);
    } catch (error) {
        console.error('[admin-account/edit] load failed:', error.message);
        return res.redirect('/clients?editError=notfound');
    }
});

router.post('/admin/accounts/:type/:id/edit', requireAuth, requireMaster, accountDocumentUpload.fields([
    { name: 'profilePhoto', maxCount: 1 },
    { name: 'identityDocument', maxCount: 1 },
    { name: 'taxCard', maxCount: 1 },
    { name: 'businessLicense', maxCount: 1 }
]), verifyUploadedDocuments, verifyMultipartCsrf, async (req, res) => {
    try {
        const result = await updateEditableAccount({
            type: req.params.type,
            id: req.params.id,
            payload: req.body || {},
            uploads: req.files || {}
        });

        const phoneChange = await notifyAccountPhoneChanged({
            oldPhone: result.oldData.phone,
            newPhone: result.newData.phone,
            accountName: result.account.name,
            accountLabel: result.definition.label
        });

        await logAction({
            action: 'ADMIN_ACCOUNT_UPDATED',
            req,
            performedById: req.session.adminId,
            performedByModel: 'Admin',
            performedByName: req.session.adminName || req.session.adminUsername || 'الإدارة',
            targetId: result.account._id,
            targetModel: result.definition.modelName,
            oldData: result.oldData,
            newData: result.newData,
            result: 'ناجح',
            metadata: {
                accountType: result.definition.type,
                accountLabel: result.definition.label,
                changedFields: result.changedFields,
                passwordChanged: Boolean(result.passwordChanged),
                secretChanges: result.secretChanges || [],
                uploadedDocuments: result.uploadedDocumentKinds || [],
                phoneChangeWhatsApp: phoneChange
            }
        }).catch(() => {});

        const io = req.app?.get('io');
        if (io) io.emit('update_data');

        const returnUrl = getReturnUrl(result.definition.type, result.account);
        const separator = returnUrl.includes('?') ? '&' : '?';
        return res.redirect(`${returnUrl}${separator}profileUpdated=1`);
    } catch (error) {
        console.error('[admin-account/edit] update failed:', error.stack || error.message);
        try {
            return await renderEditor(req, res, {
                error: getErrorMessage(error),
                submitted: req.body || {},
                statusCode: 422
            });
        } catch (renderError) {
            console.error('[admin-account/edit] error render failed:', renderError.message);
            return res.redirect('/clients?editError=failed');
        }
    }
});

module.exports = router;
