'use strict';
const challenge = require('../utils/loginSecurityChallenge');
const approval = require('../utils/loginMethodApproval');
const { smsPhoneForAccount, maskSmsPhone, phoneProof, verifiedSmsPhone } = require('../utils/smsLoginPhone');
const { normalizeSubmittedOtp } = require('../utils/otp');
const transport = require('./smsLoginTransport');
const retail = require('../utils/retailLoginMethods');

const assertCustomer = (ctx) => {
    if (!retail.isChoiceContext(ctx))
        throw challenge.fail('NOT_ALLOWED', 'هذه الخدمة غير متاحة لهذا الحساب.', 403);
};
const present = (ctx) => {
    assertCustomer(ctx);
    const phone = smsPhoneForAccount(ctx.actor);
    const pending = ctx.actor.smsOtpEnrollment;
    const stage = challenge.valid(pending, ctx.actor, ctx.sessionId) && pending.phoneHash === phoneProof(phone)
        && pending.attempts < 5 && pending.stage === 'sms' ? pending.stage : null;
    return {
        phone: maskSmsPhone(phone),
        eligible: Boolean(phone),
        configured: transport.configured(),
        verified: Boolean(verifiedSmsPhone(ctx.actor)),
        selected: retail.deliveryMethods(ctx.actor).includes('sms'),
        stage,
    };
};
const guardFor = (actor) => ({
    ...challenge.guard(actor),
    phone: actor.phone,
    ...(actor.role === 'agent' ? { contactPhone: actor.contactPhone || { $in: [null, ''] } } : {}),
    sessionVersion: actor.sessionVersion || { $in: [null, 0] },
});
const pendingGuard = (item) => ({
    'smsOtpEnrollment.id': item.id,
    'smsOtpEnrollment.stage': item.stage,
    'smsOtpEnrollment.expiresAt': { $gt: Date.now() },
});
const changed = () => challenge.fail('CHANGED', 'تغيّر رقم الهاتف أو إعدادات الأمان. حدّث الصفحة.', 409);
const deliver = async (ctx, item, phone) => {
    let pin;
    try {
        pin = await transport.sendPin(phone);
    } catch (_) {
        throw challenge.fail('SEND_FAILED', 'تعذر إرسال رسالة SMS. انتظر دقيقة قبل طلب رمز جديد.', 503);
    }
    const sent = await ctx.Model.updateOne(
        { ...guardFor(ctx.actor), ...pendingGuard(item) },
        { $set: { 'smsOtpEnrollment.stage': 'sms', 'smsOtpEnrollment.hash': challenge.hash(`sms:${item.id}:sms:${pin}`) } }
    );
    if (!sent.modifiedCount) throw changed();
    return { stage: 'sms', phone: maskSmsPhone(phone) };
};
const start = async (ctx) => {
    assertCustomer(ctx);
    const { actor, Model } = ctx;
    await challenge.password(actor, ctx.password);
    retail.requireRecentProof(ctx);
    const phone = smsPhoneForAccount(actor);
    if (!phone)
        throw challenge.fail('PHONE_INVALID', 'يلزم رقم هاتف ليبي مسجّل يبدأ بـ091 أو 092 أو 093 أو 094.');
    if (!transport.configured())
        throw challenge.fail('UNAVAILABLE', 'إرسال رسائل SMS غير متاح حاليًا.', 503);
    if (retail.deliveryMethods(actor).includes('sms')) {
        if (verifiedSmsPhone(actor)) return { stage: 'complete', phone: maskSmsPhone(phone) };
        throw challenge.fail('PHONE_CHANGED', 'تغير الرقم المرتبط بالتحقق. تواصل مع الدعم لتحديث طريقة الدخول.', 409);
    }
    const item = challenge.pending(actor, ctx.sessionId, {
        phoneHash: phoneProof(phone),
        stage: 'sending-sms',
    });
    const reserved = await Model.updateOne({
        ...guardFor(actor),
        $and: [{
            $or: [
                { 'smsOtpEnrollment.issuedAt': { $lte: item.issuedAt - 60000 } },
                { 'smsOtpEnrollment.issuedAt': { $exists: false } },
            ],
        }],
    }, { $set: { smsOtpEnrollment: item } });
    if (!reserved.modifiedCount)
        throw challenge.fail('COOLDOWN', 'انتظر دقيقة قبل طلب رمز جديد أو حدّث الصفحة.', 429);
    return deliver(ctx, item, phone);
};
const confirm = async (ctx) => {
    assertCustomer(ctx);
    const { actor, Model } = ctx;
    retail.requireRecentProof(ctx);
    const item = actor.smsOtpEnrollment;
    const phone = smsPhoneForAccount(actor);
    if (!challenge.valid(item, actor, ctx.sessionId) || !phone || item.phoneHash !== phoneProof(phone)
        || item.stage !== 'sms')
        throw challenge.fail('EXPIRED', 'انتهت صلاحية الرمز. اطلب رمزًا جديدًا.', 410);
    if (!transport.configured())
        throw challenge.fail('UNAVAILABLE', 'إرسال رسائل SMS غير متاح حاليًا.', 503);
    const guard = { ...guardFor(actor), ...pendingGuard(item) };
    const attempted = await Model.updateOne(
        { ...guard, 'smsOtpEnrollment.attempts': { $lt: 5 } },
        { $inc: { 'smsOtpEnrollment.attempts': 1 } }
    );
    if (!attempted.modifiedCount)
        throw challenge.fail('ATTEMPTS', 'انتهت محاولات التحقق. اطلب رمزًا جديدًا.', 410);
    const pin = typeof ctx.code === 'string' && ctx.code.length <= 64 ? normalizeSubmittedOtp(ctx.code) : '';
    if (!/^\d{6}$/.test(pin) || !challenge.matches(item.hash, `sms:${item.id}:${item.stage}:${pin}`))
        throw challenge.fail('CODE', 'رمز التحقق غير صحيح.');
    const enabled = await Model.updateOne(guard, {
        $set: { ...retail.enableDelivery(actor, 'sms'), smsOtpVerifiedPhoneHash: item.phoneHash, ...approval.grant(actor, 'sms') },
        $inc: { emailOtpSettingsRevision: 1 },
        $unset: { smsOtpEnrollment: 1, emailOtpEnrollment: 1, telegramOtpEnrollment: 1, loginChannelAction: 1, ...challenge.unsetLogin },
    });
    if (!enabled.modifiedCount) throw changed();
    if (ctx.session) ctx.session.retailLoginProof = retail.recentProof(actor, 'sms', 1);
    return { stage: 'complete', phone: maskSmsPhone(phone) };
};

module.exports = { present, start, confirm };
