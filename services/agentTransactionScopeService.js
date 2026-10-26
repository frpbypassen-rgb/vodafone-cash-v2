'use strict';

const SubAccount = require('../models/SubAccount');
const { tenantMode } = require('../middlewares/tenantResolver');
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');

// Reports, transaction details and receipt downloads must use the same boundary.
const buildAgentTransactionScope = async ({ agent, actor = agent, purpose = 'transactions' }) => {
    if (!agent?._id || agent.role !== 'agent' || !actor?._id) throw new Error('INVALID_AGENT_SCOPE');
    const tenant = {};
    if (tenantMode() === 'multi') {
        if (!agent.tenantId) throw new Error('AGENT_TENANT_REQUIRED');
        tenant.tenantId = agent.tenantId;
    }
    const customerIds = await SubAccount.find({
        masterType: 'user',
        masterId: agent._id,
        status: { $ne: 'deleted' },
        ...tenant,
    }).distinct('_id');
    const ownership = {
        ...tenant,
        $or: [
            ...[agent.phone, agent.webUsername]
                .filter(Boolean)
                .map((userId) => ({ userId, companyId: null, subAccountId: null })),
            { subAccountId: { $in: customerIds } },
        ],
    };
    const permissions = resolveAgentPermissions(actor);
    if (purpose === 'reports' ? permissions.canViewAllReports : purpose === 'details' ? permissions.canViewAllReports || permissions.canViewAllTransactions : permissions.canViewAllTransactions) return ownership;
    const ownRecords = [{ clientActorId: String(actor._id) }];
    if (actor.name) ownRecords.push({ clientActorId: { $exists: false }, employeeName: actor.name });
    return { $and: [ownership, { $or: ownRecords }] };
};

module.exports = { buildAgentTransactionScope };
