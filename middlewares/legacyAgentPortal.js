'use strict';

const { loadAgentPortalActor } = require('../services/agentPortalAccessService');
const agentPortal = require('../routes/agentPortal');

// Compatibility for saved URLs and tabs opened before the portal was separated.
module.exports = async (req, res, next) => {
    if (!req.session?.isClientLoggedIn || !['user', 'agent_staff'].includes(req.session.accountType))
        return next();
    if (/^\/(login|register|verify|sw\.js)(\/|$)/.test(req.path)) return next();
    try {
        req.agentPortalIdentity = await loadAgentPortalActor(req, { lean: true });
    } catch (error) {
        if (error.message === 'NOT_BUSINESS_PORTAL') return next();
        // Let the client authentication guard handle expired/MFA sessions.
        return next();
    }
    if (req.method === 'GET' && !req.path.startsWith('/api/'))
        return res.redirect(302, '/agent-portal' + req.url);
    return agentPortal(req, res, next);
};
