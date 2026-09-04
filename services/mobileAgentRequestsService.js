'use strict';

const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const RegistrationRequest = require('../models/RegistrationRequest');
const { logAction } = require('./auditService');
const { CODE_LENGTHS, assignGeneratedAccountCode } = require('./accountCodeService');
const { prepareRegistrationIdentityForApproval } = require('./registrationIdentityService');

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
        if (!actor || actor.status !== 'active' || actor.canManageAgent !== true) throw forbidden();
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

const findPending = async (req) => {
    const context = await resolveAgentActor(req);
    const request = await RegistrationRequest.findOne({
        _id: req.params.id,
        accountType: 'new',
        status: 'pending_agent',
        agentId: context.agent._id
    });
    if (!request) {
        const error = new Error('NOT_FOUND');
        error.code = 'NOT_FOUND';
        throw error;
    }
    return { ...context, request };
};

const approve = async (req) => {
    const { actor, agent, actorModel, request } = await findPending(req);
    await prepareRegistrationIdentityForApproval({
        phone: request.phone,
        username: request.username,
        excludeRequestId: request._id
    });
    const subAccount = await SubAccount.create({
        masterType: 'user',
        masterId: agent._id,
        tenantId: (req.tenant && req.tenant._id) || agent.tenantId || undefined,
        name: request.fullName,
        phone: request.phone,
        webUsername: request.username,
        webPassword: request.password,
        status: 'active',
        balance: 0
    });
    await assignGeneratedAccountCode({
        Model: SubAccount,
        modelName: 'SubAccount',
        id: subAccount._id,
        length: CODE_LENGTHS.subAccount
    });
    request.status = 'approved';
    request.reviewedBy = actor.name || actor.webUsername;
    request.reviewedAt = new Date();
    await request.save();
    await logAction({
        action: 'REGISTRATION_APPROVED', req,
        performedById: actor._id, performedByModel: actorModel, performedByName: actor.name,
        targetId: subAccount._id, targetModel: 'SubAccount', result: 'ناجح',
        metadata: { regRequestId: String(request._id), agentId: String(agent._id) }
    });
    return toRequestDto(request);
};

const reject = async (req) => {
    const { actor, agent, actorModel, request } = await findPending(req);
    request.status = 'rejected';
    request.reviewedBy = actor.name || actor.webUsername;
    request.reviewedAt = new Date();
    request.adminNotes = [request.adminNotes, String(req.body && req.body.notes || '').trim() || 'تم الرفض من الوكيل']
        .filter(Boolean)
        .join('\n');
    await request.save();
    await logAction({
        action: 'REGISTRATION_REJECTED', req,
        performedById: actor._id, performedByModel: actorModel, performedByName: actor.name,
        result: 'مرفوض',
        metadata: { regRequestId: String(request._id), agentId: String(agent._id) }
    });
    return toRequestDto(request);
};

module.exports = { list, approve, reject };
