'use strict';
const { resolveWorkspace } = require('./businessPortalService');
const { resolveCanonicalRole } = require('./companyAccessService');
const models = {
    User: require('../models/User'),
    SubAccount: require('../models/SubAccount'),
    ClientEmployee: require('../models/ClientEmployee'),
    AgentEmployee: require('../models/AgentEmployee'),
};
const context = async (req) => {
    if (['user', 'sub_client'].includes(req.session?.accountType)) {
        if (!req.session?.isClientLoggedIn || !req.session.clientId)
            throw Object.assign(new Error('انتهت الجلسة.'), { statusCode: 401 });
        const Model = req.session.accountType === 'sub_client' ? models.SubAccount : models.User;
        const actor = await Model.findById(req.session.clientId).select(
            '+emailOtpEnrollment +telegramOtpEnrollment +loginChannelAction +telegramLoginChatId +telegramLoginUserId'
        );
        if (!actor || actor.status !== 'active')
            throw Object.assign(new Error('انتهت الجلسة.'), { statusCode: 401 });
        const multi = require('../middlewares/tenantResolver').tenantMode() === 'multi';
        if (multi && (!req.tenant?._id || String(actor.tenantId || '') !== String(req.tenant._id)))
            throw Object.assign(new Error('انتهت الجلسة.'), { statusCode: 401 });
        if (req.session.accountType === 'sub_client' || actor.role !== 'agent') {
            if (Model === models.SubAccount) {
                const Parent =
                    actor.masterType === 'company' ? require('../models/ClientCompany') : models.User;
                const parent = await Parent.findById(actor.masterId).select('status tenantId').lean();
                if (
                    !parent ||
                    parent.status !== 'active' ||
                    (multi && String(parent.tenantId || '') !== String(actor.tenantId || ''))
                )
                    throw Object.assign(new Error('الحساب الرئيسي غير متاح.'), { statusCode: 403 });
            }
            return {
                actor,
                Model,
                sessionId: req.sessionID,
                kind: 'customer',
                isOwner: true,
                profileEmail:
                    Model === models.SubAccount
                        ? actor.contactEmail || actor.email
                        : actor.businessProfile?.email || actor.email,
            };
        }
    }
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
