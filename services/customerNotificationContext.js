'use strict';
const { context } = require('./businessLoginSecurityContext');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const resolve = async (req) => {
    const ctx = await context(req);
    if (ctx.kind !== 'customer') throw fail('FORBIDDEN', 'غير متاح لهذا الحساب.', 403);
    return {
        actor: ctx.actor,
        entity: ctx.actor,
        actorModel: ctx.Model.modelName,
        isCustomer: true,
        accountType: req.session.accountType,
    };
};
const scope = (ctx) => ({
    ownerModel: ctx.actorModel,
    ownerId: ctx.actor._id,
    tenantId: ctx.entity.tenantId || null,
});
module.exports = { resolve, scope, fail };
