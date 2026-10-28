'use strict';
const { resolveWorkspace } = require('./businessPortalService');
const { resolveCanonicalRole } = require('./companyAccessService');
const models = {
    User: require('../models/User'),
    ClientEmployee: require('../models/ClientEmployee'),
    AgentEmployee: require('../models/AgentEmployee'),
};
const context = async (req) => {
    const workspace = await resolveWorkspace(req);
    const Model = models[workspace.actorModel];
    if (!Model) throw Object.assign(new Error('غير متاح لهذا الحساب.'), { statusCode: 403 });
    const actor = await Model.findById(workspace.actor._id).select(
        '+emailOtpEnrollment +telegramOtpEnrollment +loginChannelAction +telegramLoginChatId +telegramLoginUserId'
    );
    if (!actor || actor.status !== 'active')
        throw Object.assign(new Error('انتهت الجلسة.'), { statusCode: 401 });
    return {
        actor,
        Model,
        sessionId: req.sessionID,
        kind: workspace.isCompany ? 'company' : 'agent',
        profileEmail: workspace.entity.businessProfile?.email,
        isOwner:
            workspace.actorModel === 'User' ||
            (workspace.isCompany && resolveCanonicalRole(actor) === 'owner'),
    };
};
module.exports = { context, models };
