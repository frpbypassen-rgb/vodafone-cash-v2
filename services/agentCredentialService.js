'use strict';
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');

const credentialFields = [
    'refreshToken',
    'otpCode',
    'otpExpires',
    'otpChallengeId',
    'otpIssuedAt',
    'otpAttempts',
];
const nextVersion = { $add: [{ $ifNull: ['$sessionVersion', 0] }, 1] };
const requireUpdated = (record) => {
    if (record) return record;
    const error = new Error('AGENT_ACCOUNT_CHANGED');
    error.code = 'AGENT_ACCOUNT_CHANGED';
    throw error;
};

// Pipeline updates bypass password save hooks: hash exactly once before the atomic write.
exports.rotateAgentPassword = async ({
    accountModel,
    accountId,
    agentId,
    expectedPasswordHash,
    newPassword,
    requireActive = false,
}) => {
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
        throw new Error('INVALID_PASSWORD');
    }
    const Model = accountModel === 'User' ? User : accountModel === 'AgentEmployee' ? AgentEmployee : null;
    if (!Model || (accountModel === 'AgentEmployee' && !agentId)) throw new Error('INVALID_AGENT_ACCOUNT');
    const filter =
        accountModel === 'User'
            ? { _id: accountId, role: 'agent', status: 'active' }
            : {
                  _id: accountId,
                  agentId,
                  role: { $in: ['employee', 'accountant'] },
                  status: requireActive ? 'active' : { $ne: 'deleted' },
              };
    if (expectedPasswordHash !== undefined) filter.webPassword = expectedPasswordHash;
    const hash = await bcrypt.hash(newPassword, 12);
    return requireUpdated(
        await Model.findOneAndUpdate(
            filter,
            [
                { $set: { webPassword: { $literal: hash }, sessionVersion: nextVersion } },
                { $unset: credentialFields },
            ],
            { returnDocument: 'after', updatePipeline: true }
        )
    );
};

exports.setAgentStaffStatus = async ({ staffId, agentId, expectedStatus, nextStatus }) => {
    if (!['active', 'banned'].includes(nextStatus) || expectedStatus === 'deleted')
        throw new Error('INVALID_STAFF_STATUS');
    return requireUpdated(
        await AgentEmployee.findOneAndUpdate(
            {
                _id: staffId,
                agentId,
                status: expectedStatus,
                role: { $in: ['employee', 'accountant'] },
            },
            [
                {
                    $set: {
                        status: nextStatus,
                        sessionVersion: {
                            $cond: [
                                { $eq: ['$status', nextStatus] },
                                { $ifNull: ['$sessionVersion', 0] },
                                nextVersion,
                            ],
                        },
                    },
                },
                ...(nextStatus === 'banned' ? [{ $unset: credentialFields }] : []),
            ],
            { returnDocument: 'after', updatePipeline: true }
        )
    );
};
