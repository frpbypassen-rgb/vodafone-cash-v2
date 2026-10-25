const { cleanText, redirectWithMessage, passwordPageHref } = require('./common');
('use strict');
const businessPortalService = require('../../services/businessPortalService');
const { loadCompanyAccess, assertCapability } = require('../../services/companyAccessService');
const ClientCompany = require('../../models/ClientCompany');
const User = require('../../models/User');
const { logAction } = require('../../services/auditService');
const { rotateAgentPassword } = require('../../services/agentCredentialService');
const bcrypt = require('bcryptjs');
const { applyOwnPasswordChange } = require('../../services/companyPasswordService');
const ClientEmployee = require('../../models/ClientEmployee');
const AgentEmployee = require('../../models/AgentEmployee');
const { normalizeClientTheme, buildClientThemePreferenceUpdate } = require('../../utils/clientPortalTheme');
const SubAccount = require('../../models/SubAccount');

exports.postUpdateSettings = async (req, res) => {
    try {
        const workspace = await businessPortalService.resolveWorkspace(req);
        if (workspace.isCompany) {
            const companyCtx = await loadCompanyAccess(req);
            assertCapability(companyCtx.access, 'canManageCompanyProfile');
        } else if (!workspace.permissions.canEditSettings) {
            return redirectWithMessage(res, '/client/settings', 'settingsError', 'forbidden');
        }
        const Model = workspace.isCompany ? ClientCompany : User;
        const entity = await Model.findById(workspace.entity._id);
        if (!entity) return redirectWithMessage(res, '/client/settings', 'settingsError', 'notfound');

        entity.businessProfile = {
            contactName: cleanText(req.body.contactName, 120),
            email: cleanText(req.body.email, 160).toLowerCase(),
            city: cleanText(req.body.city, 80),
            address: cleanText(req.body.address, 240),
            registrationNumber: cleanText(req.body.registrationNumber, 80),
        };
        if (cleanText(req.body.phone, 32)) entity.phone = cleanText(req.body.phone, 32);
        await entity.save();

        await logAction({
            action: 'SETTINGS_UPDATED',
            req,
            performedById: workspace.actor._id,
            performedByModel: workspace.actorModel,
            performedByName: workspace.actor.name,
            targetId: entity._id,
            targetModel: workspace.entityModel,
            result: 'ناجح',
            metadata: { portal: workspace.type, section: 'business_profile' },
        });
        return redirectWithMessage(res, '/client/settings', 'settingsSuccess', 'profile');
    } catch (error) {
        console.error('[Business Portal] settings update failed:', error.message);
        return redirectWithMessage(res, '/client/settings', 'settingsError', 'server');
    }
};

exports.postChangePassword = async (req, res) => {
    let workspace;
    try {
        workspace = await businessPortalService.resolveWorkspace(req);
        const Model =
            workspace.actorModel === 'ClientEmployee'
                ? ClientEmployee
                : workspace.actorModel === 'AgentEmployee'
                  ? AgentEmployee
                  : User;
        const actor = await Model.findById(workspace.actor._id);
        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');
        const passwordConfirm = String(req.body.passwordConfirm || '');
        if (workspace.isCompany) {
            const result = await applyOwnPasswordChange({
                actor,
                currentPassword,
                newPassword,
                passwordConfirm,
                req,
                portal: workspace.type,
            });
            req.session.clientSessionVersion = result.sessionVersion;
            return redirectWithMessage(res, passwordPageHref(workspace), 'settingsSuccess', 'password');
        }
        if (!actor || !(await bcrypt.compare(currentPassword, actor.webPassword || ''))) {
            return redirectWithMessage(res, passwordPageHref(workspace), 'settingsError', 'current_password');
        }
        if (newPassword.length < 8 || newPassword.length > 128 || newPassword !== passwordConfirm) {
            return redirectWithMessage(res, passwordPageHref(workspace), 'settingsError', 'new_password');
        }
        const updated = await rotateAgentPassword({
            accountModel: workspace.actorModel,
            accountId: actor._id,
            agentId: workspace.entity?._id || actor.agentId,
            expectedPasswordHash: actor.webPassword,
            newPassword,
            requireActive: true,
        });
        req.session.clientSessionVersion = updated.sessionVersion;
        await logAction({
            action: 'USER_PASSWORD_CHANGED',
            req,
            performedById: actor._id,
            performedByModel: workspace.actorModel,
            performedByName: actor.name,
            targetId: actor._id,
            targetModel: workspace.actorModel,
            result: 'ناجح',
            metadata: { selfService: true, portal: workspace.type, sessionInvalidated: true },
        });
        return redirectWithMessage(res, passwordPageHref(workspace), 'settingsSuccess', 'password');
    } catch (error) {
        if (error.code === 'CURRENT_PASSWORD') {
            return redirectWithMessage(res, passwordPageHref(workspace), 'settingsError', 'current_password');
        }
        if (error.code === 'NEW_PASSWORD') {
            return redirectWithMessage(res, passwordPageHref(workspace), 'settingsError', 'new_password');
        }
        console.error('[Business Portal] password update failed:', error.message);
        return redirectWithMessage(res, passwordPageHref(workspace), 'settingsError', 'server');
    }
};

exports.postClientTheme = async (req, res) => {
    const theme = normalizeClientTheme(req.body?.theme);
    const fail = (status, error) => {
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(status).json({ success: false, error });
        }
        return redirectWithMessage(res, '/client/settings', 'settingsError', 'theme');
    };
    if (!theme) return fail(400, 'INVALID_THEME');
    if (req.session.accountType === 'company') return fail(403, 'COMPANY_THEME_ONLY');

    req.session.clientTheme = theme;
    const Model =
        req.session.accountType === 'agent_staff'
            ? AgentEmployee
            : req.session.accountType === 'sub_client'
              ? SubAccount
              : User;
    try {
        await Model.updateOne(
            { _id: req.session.clientId },
            { $set: buildClientThemePreferenceUpdate(theme) }
        );
    } catch (_error) {
        /* session still holds the preference */
    }
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.json({ success: true, theme });
    }
    return redirectWithMessage(res, req.body.returnTo || '/client/settings', 'settingsSuccess', 'theme');
};
