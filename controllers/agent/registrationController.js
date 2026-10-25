'use strict';
const { getAgentActor } = require('../../services/agentPortalContextService');
const {
    approveAgentRegistration,
    rejectAgentRegistration,
} = require('../../services/agentRegistrationService');
const { resolveAgentPermissions } = require('../../utils/agentPortalPolicy');

const review = (action, success) => async (req, res) => {
    try {
        const context = await getAgentActor(req);
        if (!resolveAgentPermissions(context.actor).canManageCustomers)
            return res.status(403).send('غير مصرح بمراجعة طلبات العملاء.');
        await action({ req, ...context, id: req.params.id });
        return res.redirect('/client/customers?requestSuccess=' + success);
    } catch (error) {
        const code =
            error.code === 'NOT_FOUND'
                ? 'notfound'
                : ['USERNAME_TAKEN', 'PHONE_TAKEN', 'IDENTITY_PENDING', 'IDENTITY_TAKEN'].includes(
                        error.message
                    )
                  ? 'duplicate'
                  : 'server';
        console.error('[Agent Requests] review failed:', error.message);
        return res.redirect('/client/customers?requestError=' + code);
    }
};
exports.postApproveClientRequest = review(approveAgentRegistration, 'approved');
exports.postRejectClientRequest = review(rejectAgentRegistration, 'rejected');
