'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { logAction } = require('../services/auditService');
const {
    findEditableAccount,
    updateEditableAccount,
    loadEditOptions,
    getReturnUrl,
    getErrorMessage
} = require('../services/adminAccountManagementService');

const BOOLEAN_FIELDS = Object.freeze([
    'canViewAllReports',
    'canManageCompany',
    'canCreateCompanyStaff',
    'canManageAgent',
    'canCreateAgentStaff'
]);

const isChecked = (value) => ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());

const accountToFormData = (account, submitted = null) => {
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
        telegramId: account.telegramId || '',
        apiUrl: account.apiUrl || '',
        apiUsername: account.apiUsername || '',
        apiServiceId: account.apiServiceId ?? 85,
        apiProviderId: account.apiProviderId ?? 16,
        apiFieldId: account.apiFieldId ?? 5488,
        apiMachineSerial: account.apiMachineSerial || 'XP1',
        contactName: businessProfile.contactName || '',
        email: businessProfile.email || '',
        city: businessProfile.city || '',
        address: businessProfile.address || '',
        registrationNumber: businessProfile.registrationNumber || '',
        canViewAllReports: Boolean(account.canViewAllReports),
        canManageCompany: Boolean(account.canManageCompany),
        canCreateCompanyStaff: Boolean(account.canCreateCompanyStaff),
        canManageAgent: Boolean(account.canManageAgent),
        canCreateAgentStaff: Boolean(account.canCreateAgentStaff),
        newPassword: '',
        apiPassword: '',
        apiToken: ''
    };

    if (!submitted) return base;
    const merged = { ...base, ...submitted, newPassword: '', apiPassword: '', apiToken: '' };
    BOOLEAN_FIELDS.forEach((field) => { merged[field] = isChecked(submitted[field]); });
    return merged;
};

const activePageForType = (type) => {
    if (type === 'executor') return 'executors';
    if (type.includes('employee')) return 'employees';
    return 'clients';
};

const renderEditor = async (req, res, { error = '', submitted = null, statusCode = 200 } = {}) => {
    const { definition, account } = await findEditableAccount(req.params.type, req.params.id);
    const options = await loadEditOptions(definition.type, account);
    return res.status(statusCode).render('admin_account_edit', {
        account,
        accountType: definition.type,
        accountLabel: definition.label,
        formData: accountToFormData(account, submitted),
        options,
        returnUrl: getReturnUrl(definition.type, account),
        activePage: activePageForType(definition.type),
        error,
        query: req.query || {}
    });
};

router.get('/admin/accounts/:type/:id/edit', requireAuth, requireMaster, async (req, res) => {
    try {
        return await renderEditor(req, res);
    } catch (error) {
        console.error('[admin-account/edit] load failed:', error.message);
        return res.redirect('/clients?editError=notfound');
    }
});

router.post('/admin/accounts/:type/:id/edit', requireAuth, requireMaster, async (req, res) => {
    try {
        const result = await updateEditableAccount({
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
                passwordChanged: Boolean(result.passwordChanged),
                secretChanges: result.secretChanges || []
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
