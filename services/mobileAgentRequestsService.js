'use strict';

const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');
const RegistrationRequest = require('../models/RegistrationRequest');
const { approveAgentRegistration, rejectAgentRegistration } = require('./agentRegistrationService');
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');

const forbidden = () => {
    const error = new Error('FORBIDDEN');
    error.code = 'FORBIDDEN';
    return error;
};

const resolveAgentActor = async (req) => {
    if (!req.user) throw forbidden();

    if (req.user.accountType === 'client_user') {
        const agent = await User.findById(req.user.userId);
        if (!agent || agent.status !== 'active' || agent.role !== 'agent') throw forbidden();
        return { actor: agent, agent, actorModel: 'User', canReview: true };
    }

    if (req.user.accountType === 'agent_staff') {
        const actor = await AgentEmployee.findById(req.user.userId);
        if (!actor || actor.status !== 'active' || !resolveAgentPermissions(actor).canManageCustomers) throw forbidden();
        const agent = await User.findById(actor.agentId);
        if (!agent || agent.status !== 'active' || agent.role !== 'agent') throw forbidden();
        return { actor, agent, actorModel: 'AgentEmployee', canReview: true };
    }
    throw forbidden();
};

const toRequestDto = (request) => ({
    id: String(request._id),
    clientName: request.fullName || request.name || '---',
    clientPhone: request.phone || '',
    status: request.status === 'pending_agent' ? 'pending' : request.status,
    createdAt: request.createdAt ? new Date(request.createdAt).toISOString() : null
});

const list = async (req) => {
    const { agent } = await resolveAgentActor(req);
    const requests = await RegistrationRequest.find({
        accountType: 'new',
        agentId: agent._id,
        status: { $in: ['pending_agent', 'approved', 'rejected'] }
    }).sort({ createdAt: -1 }).limit(100).lean();
    return requests.map(toRequestDto);
};

const approve = async (req) => toRequestDto(await approveAgentRegistration({ req, ...await resolveAgentActor(req), id: req.params.id }));
const reject = async (req) => toRequestDto(await rejectAgentRegistration({ req, ...await resolveAgentActor(req), id: req.params.id }));

module.exports = { list, approve, reject };
