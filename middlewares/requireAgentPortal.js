'use strict';

const { requireClientAuth } = require('./clientPortalAuth');
const { loadAgentPortalActor } = require('../services/agentPortalAccessService');

const requireAgentPortal = (req, res, next) => {
    if (!req.session?.isClientLoggedIn) return requireClientAuth(req, res, next);
    if (!['user', 'agent_staff'].includes(req.session?.accountType)) {
        return res
            .status(403)
            .json({ success: false, code: 'AGENT_PORTAL_ONLY', error: 'هذه البوابة مخصصة لحسابات الوكلاء.' });
    }
    return requireClientAuth(req, res, async () => {
        try {
            req.agentPortalIdentity = await loadAgentPortalActor(req, { lean: true });
            if (!req.agentPortalResponseBound) {
                const redirect = res.redirect.bind(res);
                res.redirect = (...args) => {
                    const last = args.length - 1;
                    if (typeof args[last] === 'string')
                        args[last] = args[last].replace(/^\/client(?=\/|$)/, '/agent-portal');
                    return redirect(...args);
                };
                req.agentPortalResponseBound = true;
            }
            return next();
        } catch (error) {
            return res.status(error.statusCode || 403).json({
                success: false,
                code: 'AGENT_PORTAL_ONLY',
                error: 'لا توجد صلاحية لدخول بوابة الوكلاء.',
            });
        }
    });
};

module.exports = requireAgentPortal;
