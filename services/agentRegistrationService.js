'use strict';

const mongoose = require('mongoose');
const RegistrationRequest = require('../models/RegistrationRequest');
const SubAccount = require('../models/SubAccount');
const { CODE_LENGTHS, assignGeneratedAccountCode } = require('./accountCodeService');
const { prepareRegistrationIdentityForApproval } = require('./registrationIdentityService');
const { logAction } = require('./auditService');
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');

const pendingFilter = (id, agent) => ({
    _id: id,
    accountType: 'new',
    status: 'pending_agent',
    agentId: agent._id,
});
const notFound = () => Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND', statusCode: 404 });
const assertReviewer = ({ actor, agent, actorModel }) => {
    if (
        !actor ||
        !agent ||
        actor.status !== 'active' ||
        agent.status !== 'active' ||
        agent.role !== 'agent' ||
        !resolveAgentPermissions(actor).canManageCustomers ||
        (actorModel === 'AgentEmployee'
            ? String(actor.agentId) !== String(agent._id)
            : String(actor._id) !== String(agent._id))
    ) {
        throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN', statusCode: 403 });
    }
};

const approveAgentRegistration = async ({ req, actor, agent, actorModel, id }) => {
    assertReviewer({ actor, agent, actorModel });
    const session = await mongoose.startSession();
    let approved;
    try {
        // Approval and customer/code creation commit together. A concurrent
        // approval or rejection cannot both consume the same pending request.
        await session.withTransaction(async () => {
            const request = await RegistrationRequest.findOneAndUpdate(
                pendingFilter(id, agent),
                {
                    $set: {
                        status: 'approved',
                        reviewedBy: actor.name || actor.webUsername,
                        reviewedAt: new Date(),
                    },
                },
                { session, new: true }
            );
            if (!request) throw notFound();
            await prepareRegistrationIdentityForApproval({
                phone: request.phone,
                username: request.username,
                excludeRequestId: request._id,
            });
            const customer = new SubAccount({
                masterType: 'user',
                masterId: agent._id,
                tenantId: agent.tenantId || undefined,
                name: request.fullName,
                phone: request.phone,
                webUsername: request.username,
                webPassword: request.password,
                status: 'active',
                balance: 0,
            });
            await customer.save({ session });
            await assignGeneratedAccountCode({
                Model: SubAccount,
                modelName: 'SubAccount',
                id: customer._id,
                length: CODE_LENGTHS.subAccount,
                session,
                tenantId: agent.tenantId,
            });
            approved = { request, customer };
        });
    } finally {
        await session.endSession();
    }
    await logAction({
        action: 'REGISTRATION_APPROVED',
        req,
        performedById: actor._id,
        performedByModel: actorModel,
        performedByName: actor.name,
        targetId: approved.customer._id,
        targetModel: 'SubAccount',
        result: 'ناجح',
        metadata: {
            regRequestId: approved.request._id,
            refCode: approved.request.refCode,
            agentId: agent._id,
        },
    });
    return approved.request;
};

const rejectAgentRegistration = async ({ req, actor, agent, actorModel, id }) => {
    assertReviewer({ actor, agent, actorModel });
    // A pipeline appends the note in the same conditional update, without a
    // read/save race against approval.
    const note =
        String(req.body?.notes || '')
            .trim()
            .slice(0, 2000) || 'تم الرفض من الوكيل';
    const request = await RegistrationRequest.findOneAndUpdate(
        pendingFilter(id, agent),
        [
            {
                $set: {
                    status: 'rejected',
                    reviewedBy: { $literal: actor.name || actor.webUsername || '' },
                    reviewedAt: '$$NOW',
                    adminNotes: {
                        $concat: [
                            {
                                $cond: [
                                    { $gt: [{ $strLenCP: { $ifNull: ['$adminNotes', ''] } }, 0] },
                                    { $concat: ['$adminNotes', '\n'] },
                                    '',
                                ],
                            },
                            { $literal: note },
                        ],
                    },
                },
            },
        ],
        { new: true, updatePipeline: true }
    );
    if (!request) throw notFound();
    await logAction({
        action: 'REGISTRATION_REJECTED',
        req,
        performedById: actor._id,
        performedByModel: actorModel,
        performedByName: actor.name,
        result: 'مرفوض',
        metadata: { regRequestId: request._id, refCode: request.refCode, agentId: agent._id },
    });
    return request;
};

module.exports = { approveAgentRegistration, rejectAgentRegistration };
