'use strict';
const approval = require('./loginMethodApproval');
const { verifiedSmsPhone } = require('./smsLoginPhone');
const { fail, revision } = require('./loginSecurityChallenge');

const deliveryKeys = ['email', 'telegram', 'sms'];
const isRetailLogin = (actor, type) => Boolean(actor) &&
    (type === 'sub_client' || (type === 'user' && actor.role !== 'agent'));
const isChoiceLogin = (actor, type) => Boolean(actor) &&
    ['user', 'sub_client', 'company', 'agent_staff'].includes(type);
const isChoiceContext = (ctx) => ['customer', 'company', 'agent'].includes(ctx.kind);
const deliveryMethods = (actor) => {
    if (Array.isArray(actor.retailLoginMethods))
        return deliveryKeys.filter(key => actor.retailLoginMethods.includes(key));
    if (!deliveryKeys.includes(actor.otpDeliveryChannel)) return [];
    const legacy = {
        email: approval.emailAllowed(actor),
        telegram: approval.telegramAllowed(actor),
        sms: actor.otpDeliveryChannel === 'sms' || Boolean(verifiedSmsPhone(actor)),
    };
    return deliveryKeys.filter(key => legacy[key]);
};
const enabledMethods = (actor) => [
    ...deliveryMethods(actor),
    ...(actor.mfaEnabled && actor.mfaType === 'totp' ? ['authenticator'] : []),
];
const preferredMethod = (actor) => {
    const active = enabledMethods(actor);
    const selected = actor.retailPreferredLoginMethod ?? actor.otpDeliveryChannel;
    return active.includes(selected) ? selected : null;
};
const enableDelivery = (actor, method) => ({
    retailLoginMethods: [...new Set([...deliveryMethods(actor), method])],
    otpDeliveryChannel: deliveryMethods(actor).includes(actor.otpDeliveryChannel) ? actor.otpDeliveryChannel : method,
});
const proofWindow = 15 * 60000;
const recentProof = (actor, method, revisionOffset = 0) => ({
    method,
    accountId: String(actor._id),
    revision: revision(actor) + revisionOffset,
    sessionVersion: Number(actor.sessionVersion || 0),
    configuredAt: method === 'authenticator' ? new Date(actor.mfaConfiguredAt || 0).getTime() : null,
    expiresAt: Date.now() + proofWindow,
});
const canManage = (actor, proof) => {
    const active = enabledMethods(actor);
    return !active.length || Boolean(proof && active.includes(proof.method) &&
        proof.accountId === String(actor._id) && proof.revision === revision(actor) &&
        proof.sessionVersion === Number(actor.sessionVersion || 0) && proof.expiresAt > Date.now() &&
        (proof.method !== 'authenticator' || proof.configuredAt === new Date(actor.mfaConfiguredAt || 0).getTime()));
};
const requireRecentProof = (ctx) => {
    if (isChoiceContext(ctx) && !canManage(ctx.actor, ctx.session?.retailLoginProof))
        throw fail('RECENT_LOGIN_REQUIRED', 'سجّل الخروج ثم ادخل بإحدى طرق التحقق المفعّلة قبل تغيير إعدادات الأمان.', 403);
};

module.exports = { deliveryKeys, isRetailLogin, isChoiceLogin, isChoiceContext, deliveryMethods, enabledMethods, preferredMethod, enableDelivery,
    recentProof, canManage, requireRecentProof };
