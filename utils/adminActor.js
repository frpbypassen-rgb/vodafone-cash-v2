'use strict';

const { logAction } = require('../services/auditService');

const ACTOR_REQUIRED = 'ADMIN_ACTOR_REQUIRED';
const ACTOR_MESSAGE = 'تعذر تحديد المدير المنفّذ للعملية. سجّل الدخول من جديد ثم أعد المحاولة.';

const isAdminActorError = (error) => error?.message === ACTOR_REQUIRED;

const requireAdminActor = (req) => {
    const id = String(req?.session?.adminId || '').trim();
    const name = String(req?.session?.adminName || '').trim();
    if (!id || !name) {
        const error = new Error(ACTOR_REQUIRED);
        error.statusCode = 401;
        error.status = 401;
        error.publicMessage = ACTOR_MESSAGE;
        throw error;
    }
    return {
        id,
        name,
        role: String(req.session?.adminRole || '').trim(),
        at: new Date()
    };
};

const routingFields = (actor) => ({
    routedByAdminId: actor.id,
    routedByAdminName: actor.name,
    routedAt: actor.at
});

const performedFields = (actor) => ({
    performedByAdminId: actor.id,
    performedByAdminName: actor.name,
    performedByAdminAt: actor.at
});

const cancellationFields = (actor) => ({
    cancelledBy: actor.name,
    cancelledByAdminId: actor.id
});

const assertNamedActor = (actor, message = ACTOR_MESSAGE) => {
    const id = String(actor?.id || '').trim();
    const name = String(actor?.name || '').trim();
    if (!id || !name) {
        const error = new Error(ACTOR_REQUIRED);
        error.statusCode = 401;
        error.status = 401;
        error.publicMessage = message;
        throw error;
    }
    return { id, name, role: String(actor.role || '').trim(), at: actor.at instanceof Date ? actor.at : new Date() };
};

const isPanelAdminRole = (role) => ['master', 'admin', 'accountant'].includes(String(role || '').trim());

const auditAdminAction = (req, actor, {
    action,
    targetId,
    targetModel = 'Transaction',
    oldData,
    newData,
    metadata,
    severity = 'critical',
    session = null
} = {}) => logAction({
    action,
    req,
    performedById: actor.id,
    performedByModel: 'Admin',
    performedByName: actor.name,
    targetId,
    targetModel,
    oldData,
    newData,
    metadata,
    required: true,
    severity,
    session
});

module.exports = {
    ACTOR_REQUIRED,
    ACTOR_MESSAGE,
    isAdminActorError,
    requireAdminActor,
    routingFields,
    performedFields,
    cancellationFields,
    assertNamedActor,
    isPanelAdminRole,
    auditAdminAction
};
