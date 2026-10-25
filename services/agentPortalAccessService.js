'use strict';

const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');
const { tenantMode } = require('../middlewares/tenantResolver');

const denied = () =>
    Object.assign(new Error('INVALID_AGENT_SESSION'), { statusCode: 403, code: 'FORBIDDEN' });

const loadAgentPortalActor = async (req, { preloadedAccount = null, lean = false } = {}) => {
    const session = req.session || {};
    if (
        !session.clientId ||
        session.mfaEnrollmentRequired ||
        !['user', 'agent_staff'].includes(session.accountType)
    )
        throw denied();
    const Model = session.accountType === 'user' ? User : AgentEmployee;
    const read = (query) => (lean ? query.lean() : query);
    const actor = preloadedAccount || (await read(Model.findById(session.clientId)));
    if (
        !actor ||
        String(actor._id) !== String(session.clientId) ||
        actor.status !== 'active' ||
        Number(actor.sessionVersion || 0) !== Number(session.clientSessionVersion || 0)
    )
        throw denied();
    if (session.accountType === 'user' && actor.role !== 'agent') {
        throw Object.assign(new Error('NOT_BUSINESS_PORTAL'), { statusCode: 404 });
    }
    if (session.accountType === 'agent_staff' && !['employee', 'accountant'].includes(actor.role))
        throw denied();
    const agent = session.accountType === 'user' ? actor : await read(User.findById(actor.agentId));
    if (!agent || agent.status !== 'active' || agent.role !== 'agent') throw denied();
    if (tenantMode() === 'multi') {
        const tenantId = req.tenant?._id;
        if (
            !tenantId ||
            String(actor.tenantId || '') !== String(tenantId) ||
            String(agent.tenantId || '') !== String(tenantId)
        )
            throw denied();
    }
    return { actor, agent, actorModel: session.accountType === 'user' ? 'User' : 'AgentEmployee' };
};

module.exports = { loadAgentPortalActor };
