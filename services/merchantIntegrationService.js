'use strict';
const crypto = require('crypto');
const { withRevision, conflict, actorLabel } = require('../utils/portalSettingsRevision');
const Company = require('../models/ClientCompany');
const User = require('../models/User');
const { hashKey } = require('../utils/merchantIntegrationPolicy');
const { tenantMode } = require('../middlewares/tenantResolver');
const fail = (code, message, statusCode = 403) => Object.assign(new Error(message), { code, statusCode });
const assertOwner = (workspace) => {
    if (!(workspace?.isCompany || workspace?.isAgent) || !workspace.permissions?.owner)
        throw fail('INTEGRATION_ACCESS_DENIED', 'إدارة مفاتيح الربط متاحة لصاحب الحساب فقط.');
};
const modelFor = (workspace) => (workspace.isCompany ? Company : User);
const scopeFor = (workspace) => ({
    _id: workspace.entity._id,
    status: 'active',
    ...(workspace.isAgent ? { role: 'agent' } : {}),
});
const getStatus = async (workspace) => {
    assertOwner(workspace);
    const entity = await modelFor(workspace)
        .findOne(scopeFor(workspace))
        .select('+merchantApiKeyHash +apiToken')
        .lean();
    if (!entity) throw fail('ACCOUNT_UNAVAILABLE', 'الحساب غير متاح.');
    return describeStatus(entity);
};
const describeStatus = entity => {
    const access = entity.integrationAccess || {};
    const legacy = entity.token || entity.apiToken || '';
    return {
        revision: access.revision || 0,
        updatedBy: access.updatedBy || '', updatedAt: access.updatedAt || null,
        apiEnabled: access.apiEnabled === true,
        webhooksEnabled: access.webhooksEnabled === true,
        keyActive:
            entity.status === 'active' && access.apiEnabled === true && !access.keyDisabled && Boolean(entity.merchantApiKeyHash || legacy),
        keyHint: access.keyHint || legacy.slice(-6),
        keyCreatedAt: access.keyCreatedAt || null,
    };
};
const rotateKey = async (workspace) => {
    assertOwner(workspace);
    const token = 'ahr_' + crypto.randomBytes(32).toString('hex');
    const row = await modelFor(workspace)
        .findOneAndUpdate(
            { ...scopeFor(workspace), 'integrationAccess.apiEnabled': true },
            {
                $set: {
                    merchantApiKeyHash: hashKey(token),
                    'integrationAccess.updatedBy': actorLabel(workspace),
                    'integrationAccess.updatedAt': new Date(),
                    'integrationAccess.keyDisabled': false,
                    'integrationAccess.keyHint': token.slice(-6),
                    'integrationAccess.keyCreatedAt': new Date(),
                },
                $inc: { 'integrationAccess.revision': 1 },
                $unset: { [workspace.isCompany ? 'token' : 'apiToken']: 1 },
            },
            { returnDocument: 'after' }
        )
        .lean();
    if (!row) throw fail('API_DISABLED', 'خدمة API غير مفعلة من الإدارة.');
    return { token };
};
const revokeKey = async (workspace) => {
    assertOwner(workspace);
    const result = await modelFor(workspace).updateOne(
        { ...scopeFor(workspace), status: { $ne: 'deleted' } },
        {
            $set: { 'integrationAccess.keyDisabled': true, 'integrationAccess.keyHint': '', 'integrationAccess.updatedBy': actorLabel(workspace), 'integrationAccess.updatedAt': new Date() },
            $inc: { 'integrationAccess.revision': 1 },
            $unset: { merchantApiKeyHash: 1, [workspace.isCompany ? 'token' : 'apiToken']: 1 },
        }
    );
    if (result.matchedCount !== 1) throw fail('ACCOUNT_UNAVAILABLE', 'تعذر إيقاف مفتاح هذا الحساب.', 404);
    return { revoked: true };
};
const setAdminAccess = async (Model, scope, flags, revision, updatedBy = 'الإدارة') => {
    if (typeof flags.apiEnabled !== 'boolean' || typeof flags.webhooksEnabled !== 'boolean')
        throw fail('INVALID_FLAGS', 'إعدادات التفعيل غير صالحة.', 400);
    if (revision === undefined) {
        const current = await Model.findOne(scope).lean();
        if (!current) throw fail('ACCOUNT_NOT_FOUND', 'الحساب غير موجود.', 404);
        revision = current.integrationAccess?.revision || 0;
    }
    const row = await Model.findOneAndUpdate(
        withRevision(scope, revision, 'integrationAccess.revision'),
        {
            $set: {
                'integrationAccess.apiEnabled': flags.apiEnabled,
                'integrationAccess.webhooksEnabled': flags.webhooksEnabled,
                'integrationAccess.updatedBy': updatedBy,
                'integrationAccess.updatedAt': new Date(),
            },
            $inc: { 'integrationAccess.revision': 1 },
        },
        { returnDocument: 'after' }
    ).lean();
    if (!row) {
        if (!await Model.exists(scope)) throw fail('ACCOUNT_NOT_FOUND', 'الحساب غير موجود.', 404);
        throw conflict();
    }
    return row;
};
const webhooksAllowed = async (owner) => {
    const Model = owner.ownerModel === 'ClientCompany' ? Company : owner.ownerModel === 'User' ? User : null;
    if (!Model) return false;
    return Boolean(
        await Model.exists({
            _id: owner.ownerId,
            status: 'active',
            ...(tenantMode() === 'multi' ? { tenantId: owner.tenantId || { $in: [] } } : {}),
            ...(owner.ownerModel === 'User' ? { role: 'agent' } : {}),
            'integrationAccess.webhooksEnabled': true,
        })
    );
};
module.exports = { describeStatus, getStatus, rotateKey, revokeKey, setAdminAccess, assertOwner, webhooksAllowed, fail };
