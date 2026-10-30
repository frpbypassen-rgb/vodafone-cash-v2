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
const TelegramAccountLink = require('../models/TelegramAccountLink');
const customerDocuments = require('../services/customerAccountDocuments');
router.get('/admin/accounts/:type/:id/documents/:documentId', requireAuth, requireMaster, async (req, res) => {
    try {
        const { definition, account } = await findEditableAccount(req.params.type, req.params.id);
        if (!['user', 'subaccount'].includes(definition.type)) return res.sendStatus(403);
        return await customerDocuments.download(account, req.params.documentId, res);
    } catch (error) { return res.status(error.statusCode || 500).send(error.statusCode ? error.message : 'تعذر تحميل الوثيقة.'); }
});
router.post('/admin/accounts/:type/:id/document-review', requireAuth, requireMaster, async (req, res) => {
    try {
        const { definition, account } = await findEditableAccount(req.params.type, req.params.id);
        if (!['user', 'subaccount'].includes(definition.type)) return res.sendStatus(403);
        await customerDocuments.review({ Model: account.constructor, actor: account, id: req.body.documentId, revision: req.body.revision, result: req.body.result, reason: req.body.reason });
        await logAction({ req, action: 'CUSTOMER_DOCUMENT_REVIEWED', performedById: req.session.adminId, performedByModel: 'Admin', targetId: account._id, targetModel: definition.modelName, metadata: { documentId: req.body.documentId, result: req.body.result } });
        return res.redirect(`/admin/accounts/${definition.type}/${account._id}/edit`);
    } catch (error) { return res.status(error.statusCode || 500).send(error.statusCode ? error.message : 'تعذر حفظ المراجعة.'); }
});
const { createAccountCode } = require('../services/telegramService');

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
    limits: { fileSize: 7 * 1024 * 1024, files: 4, fieldArrayIndexLimit: 16 },
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
        profileRevision: account.profileRevision || 0,
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
        loginSecurityRevision: account.emailOtpSettingsRevision || 0,
        otpDeliveryChannel: account.otpDeliveryChannel || 'whatsapp',
        emailOtpVerified: Boolean(account.emailOtpVerifiedAt),
        telegramLoginVerified: Boolean(account.telegramLoginVerifiedAt),
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
    const telegramCode = req.session.telegramCodeFlash?.ownerId === String(account._id)
        ? req.session.telegramCodeFlash.code : '';
    if (telegramCode) delete req.session.telegramCodeFlash;
    const telegramLink = ['user', 'agent', 'company', 'subaccount'].includes(definition.type)
        ? await TelegramAccountLink.findOne({ ownerModel: definition.modelName, ownerId: account._id }).select('+codeHint').lean()
        : null;
    const customerNotifications = ['user','subaccount'].includes(definition.type)
        ? await require('../services/customerNotificationService').status({actor:account,entity:account,actorModel:definition.modelName,isCustomer:true,accountType:definition.type==='subaccount'?'sub_client':'user'}) : null;
    return res.status(statusCode).render('admin_account_edit', {
        account,
        accountType: definition.type,
        accountLabel: definition.label,
        customerNotifications,
        formData: accountToFormData(account, submitted, { companyOwner }),
        options,
        returnUrl: getReturnUrl(definition.type, account),
        activePage: activePageForType(definition.type),
        error,
        query: req.query || {},
        csrfToken: req.session?.csrfToken || '',
        telegramLink,
        telegramCode
    });
};

router.post('/admin/accounts/:type/:id/notification-preferences', requireAuth, requireMaster, async(req,res)=>{
    try {
        const {definition,account}=await findEditableAccount(req.params.type,req.params.id);
        if(!['user','subaccount'].includes(definition.type))return res.sendStatus(403);
        const ctx={actor:{...account.toObject(),name:req.session.adminName||'الإدارة'},entity:account,actorModel:definition.modelName,isCustomer:true,accountType:definition.type==='subaccount'?'sub_client':'user'};
        await require('../services/customerNotificationService').save(ctx,{revision:Number(req.body.revision),emailRevision:Number(req.body.emailRevision),telegramRevision:Number(req.body.telegramRevision),ratesEnabled:req.body.ratesEnabled==='true',emailEnabled:req.body.emailEnabled==='true',telegramEnabled:req.body.telegramEnabled==='true'});
        await logAction({req,action:'SETTINGS_UPDATED',performedById:req.session.adminId,performedByModel:'Admin',performedByName:req.session.adminName||'الإدارة',targetId:account._id,targetModel:definition.modelName,metadata:{section:'customer_notifications'}});
        return res.redirect(`/admin/accounts/${definition.type}/${account._id}/edit`);
    } catch(error) {return res.status(error.statusCode||500).send(error.statusCode?error.message:'تعذر حفظ تفضيلات الإشعارات.');}
});

router.post('/admin/accounts/:type/:id/telegram-code', requireAuth, requireMaster, async (req, res) => {
    const { definition, account } = await findEditableAccount(req.params.type, req.params.id);
    const result = await createAccountCode({ ownerModel: definition.modelName, ownerId: account._id, tenantId: account.tenantId });
    await logAction({ action: 'ADMIN_TELEGRAM_CODE_REGENERATED', req, performedById: req.session.adminId, performedByModel: 'Admin', targetId: account._id, targetModel: definition.modelName, result: 'ناجح' }).catch(() => {});
    req.session.telegramCodeFlash = { ownerId: String(account._id), code: result.code };
    return res.redirect(`/admin/accounts/${definition.type}/${account._id}/edit`);
});

router.post('/admin/accounts/:type/:id/telegram-settings', requireAuth, requireMaster, async (req, res) => {
    const { definition, account } = await findEditableAccount(req.params.type, req.params.id);
    if (['agent', 'company'].includes(definition.type)) return res.status(409).send('استخدم لوحة إعدادات البوابة لإدارة حسابات Telegram والحالة الحالية.');
    const deliveryMode = ['off', 'whatsapp', 'telegram', 'both'].includes(req.body?.deliveryMode) ? req.body.deliveryMode : 'off';
    await TelegramAccountLink.findOneAndUpdate({ ownerModel: definition.modelName, ownerId: account._id }, { $set: { deliveryMode, active: deliveryMode !== 'off' }, $inc:{settingsRevision:1} }, { upsert: true, setDefaultsOnInsert: true });
    return res.redirect(`/admin/accounts/${definition.type}/${account._id}/edit?telegramSaved=1`);
});

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
                ownerEmailOtp: (result.definition.type === 'company'
                    ? result.newData.ownerOtpDeliveryChannel
                    : result.newData.otpDeliveryChannel) === 'email'
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
        if (['agent', 'company'].includes(req.params.type)) {
            const value = req.body.profileRevision;
            require('../utils/portalSettingsRevision').withRevision({}, typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value, 'profileRevision');
        }
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
