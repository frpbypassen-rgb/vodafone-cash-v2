'use strict';

const { loadAgentPortalActor } = require('./agentPortalAccessService');
const { resolveAgentPermissions, canAccessAgentPage } = require('../utils/agentPortalPolicy');
const { buildWorkspaceResult } = require('./portalWorkspace/factory');
const { loadPageContext: buildPageContext } = require('./portalWorkspace/context');

const resolveWorkspace = async (req) => {
    const { actor, agent, actorModel } = await loadAgentPortalActor(req, {
        preloadedAccount: req.agentPortalIdentity?.actor || null,
        lean: true,
    });
    return {
        ...buildWorkspaceResult({
            type: 'agent',
            actor,
            entity: agent,
            actorModel,
            entityModel: 'User',
            permissions: resolveAgentPermissions(actor),
        }),
        basePath: '/agent-portal',
    };
};

const loadPageContext = async (req, page) => {
    const workspace = await resolveWorkspace(req);
    const context = await buildPageContext(req, page, workspace, canAccessAgentPage);
    context.portalHomeHref = '/agent-portal/dashboard';
    context.navigation = context.navigation.map((item) => ({
        ...item,
        href: item.href.replace(/^\/client(?=\/|$)/, workspace.basePath),
    }));
    context.companyMobileNav = (context.companyMobileNav || []).map((item) => ({
        ...item,
        href: item.href?.replace(/^\/client(?=\/|$)/, workspace.basePath),
    }));
    if (context.customerMobileNav) {
        context.customerMobileNav = Object.fromEntries(
            Object.entries(context.customerMobileNav).map(([key, value]) => [
                key,
                Array.isArray(value)
                    ? value.map((item) => ({
                          ...item,
                          href: item.href?.replace(/^\/client(?=\/|$)/, workspace.basePath),
                      }))
                    : value,
            ])
        );
    }
    return context;
};

module.exports = { resolveWorkspace, loadPageContext };
