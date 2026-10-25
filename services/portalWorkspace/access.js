'use strict';

const ClientCompany = require('../../models/ClientCompany');
const ClientEmployee = require('../../models/ClientEmployee');
const { canAccessAgentPage, resolveAgentPermissions } = require('../../utils/agentPortalPolicy');
const {
    resolveCompanyAccess,
    toPortalPermissions,
    canAccessCompanyPage,
} = require('../companyAccessService');
const { buildWorkspaceResult } = require('./factory');
const { forbiddenRedirectPath } = require('./presentation');

const resolveCompanyPermissions = (actor) => toPortalPermissions(resolveCompanyAccess(actor));

const canPostPortalTransfer = (accountType, account) => {
    if (!account) return false;
    if (accountType === 'company') return resolveCompanyPermissions(account).canTransfer === true;
    if (accountType === 'agent_staff') return resolveAgentPermissions(account).canTransfer === true;
    return String(account.role || '').toLowerCase() !== 'accountant';
};

const resolveWorkspace = async (req) => {
    if (!req.session || !req.session.clientId) {
        const error = new Error('SESSION_EXPIRED');
        error.statusCode = 401;
        throw error;
    }

    if (req.session.accountType === 'company') {
        const actor = await ClientEmployee.findById(req.session.clientId).lean();
        if (!actor || actor.status !== 'active') throw new Error('INVALID_ACTOR');
        const entity = await ClientCompany.findById(actor.companyId).lean();
        if (!entity || entity.status !== 'active') throw new Error('INVALID_ENTITY');
        const permissions = resolveCompanyPermissions(actor);
        return buildWorkspaceResult({
            type: 'company',
            actor,
            entity,
            actorModel: 'ClientEmployee',
            entityModel: 'ClientCompany',
            permissions,
        });
    }

    if (['agent_staff', 'user'].includes(req.session.accountType)) {
        const { loadAgentPortalActor } = require('../agentPortalAccessService');
        const { actor, agent: entity, actorModel } = await loadAgentPortalActor(req, { lean: true });
        return buildWorkspaceResult({
            type: 'agent',
            actor,
            entity,
            actorModel,
            entityModel: 'User',
            permissions: resolveAgentPermissions(actor),
        });
    }

    const error = new Error('NOT_BUSINESS_PORTAL');
    error.statusCode = 404;
    throw error;
};

const canAccessPage = (workspace, page) => {
    if (workspace.isCompany) {
        return canAccessCompanyPage(workspace.permissions, page);
    }
    return canAccessAgentPage(workspace, page);
};

const resolveClientPostLoginHref = (accountType) =>
    accountType === 'company'
        ? '/client/services'
        : accountType === 'agent_staff'
          ? '/agent-portal/dashboard'
          : '/client/dashboard';

const redirectForbiddenPage = async (req, res) => {
    try {
        const workspace = await resolveWorkspace(req);
        return res.status(403).redirect(forbiddenRedirectPath(workspace));
    } catch (_error) {
        return res.status(403).redirect('/client/dashboard?portalError=forbidden');
    }
};

module.exports = {
    resolveCompanyPermissions,
    canPostPortalTransfer,
    resolveWorkspace,
    canAccessPage,
    resolveClientPostLoginHref,
    redirectForbiddenPage,
};
