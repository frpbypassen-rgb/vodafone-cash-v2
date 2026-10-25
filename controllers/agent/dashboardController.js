'use strict';
const { getAgentActor, buildContext } = require('../../services/agentPortalContextService');
const { dashboardPersona, resolveAgentPermissions } = require('../../utils/agentPortalPolicy');
exports.renderAgentDashboard = async (req, res, preloadedAccount = null) => {
    try {
        const { actor, agent, actorModel } = await getAgentActor(req, preloadedAccount);
        const persona = dashboardPersona(actor);
        const context = await buildContext({
            req,
            actor,
            agent,
            actorModel,
            forceToday: persona === 'employee' && !resolveAgentPermissions(actor).canViewAllReports,
        });

        if (persona === 'accountant') return res.render('client/agent_accountant_dashboard', context);
        if (persona === 'manager') return res.render('client/agent_manager_dashboard', context);
        return res.render('client/agent_employee_dashboard', context);
    } catch (error) {
        console.error('[Agent Dashboard] render failed:', error.message);
        return res.redirect('/client/logout');
    }
};
