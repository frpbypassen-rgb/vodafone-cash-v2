'use strict';
const challenge = require('../utils/loginSecurityChallenge');
const approval = require('../utils/loginMethodApproval');
const { normalizeSmsLoginPhone, maskSmsPhone, phoneProof, verifiedSmsPhone } = require('../utils/smsLoginPhone');
const { normalizeSubmittedOtp } = require('../utils/otp');
const transport = require('./smsLoginTransport');

const assertCustomer = (ctx) => {
    if (ctx.kind !== 'customer' || !ctx.isOwner)
        throw challenge.fail('NOT_ALLOWED', 'هذه الخدمة متاحة لحساب العميل.', 403);
};
const present = (ctx) => {
    assertCustomer(ctx);
    const phone = normalizeSmsLoginPhone(ctx.actor.phone);
    const pending = ctx.actor.smsOtpEnrollment;
    const stage = challenge.valid(pending, ctx.actor, ctx.sessionId) && pending.phoneHash === phoneProof(phone)
        && pending.attempts < 5 && ['current', 'sms'].includes(pending.stage) ? pending.stage : null;
    return {
        phone: maskSmsPhone(phone),
        eligible: Boolean(phone),
        configured: transport.configured(),
        verified: Boolean(verifiedSmsPhone(ctx.actor)),
        selected: ctx.actor.otpDeliveryChannel === 'sms',
        stage,
    };
};
const guardFor = (actor) => ({
    ...challenge.guard(actor),
    phone: actor.phone,
    sessionVersion: actor.sessionVersion || { $in: [null, 0] },
});
const pendingGuard = (item) => ({
    'smsOtpEnrollment.id': item.id,
    'smsOtpEnrollment.stage': item.stage,
    'smsOtpEnrollment.expiresAt': { $gt: Date.now() },
});
const changed = () => challenge.fail('CHANGED', 'تغيّر رقم الهاتف أو إعدادات الأمان. حدّث الصفحة.', 409);
const deliver = async (ctx, item, phone) => {
    const stage = item.stage === 'sending-current' ? 'current' : 'sms';
    let pin;
    try {
        pin = stage === 'current'
            ? await require('./telegramLoginSecurityService').sendCurrent(ctx, challenge.code())
            : await transport.sendPin(phone);
    } catch (_) {
        throw challenge.fail('SEND_FAILED', stage === 'current'
            ? 'تعذر إرسال رمز التأكيد إلى قناة الدخول الحالية. حاول بعد دقيقة.'
            : 'تعذر إرسال رسالة SMS. انتظر دقيقة قبل طلب رمز جديد.', 503);
    }
    const sent = await ctx.Model.updateOne(
        { ...guardFor(ctx.actor), ...pendingGuard(item) },
        { $set: { 'smsOtpEnrollment.stage': stage, 'smsOtpEnrollment.hash': challenge.hash(`sms:${item.id}:${stage}:${pin}`) } }
    );
    if (!sent.modifiedCount) throw changed();
    return { stage, phone: maskSmsPhone(phone) };
};
const start = async (ctx) => {
    assertCustomer(ctx);
    const { actor, Model } = ctx;
    await challenge.password(actor, ctx.password);
    const phone = normalizeSmsLoginPhone(actor.phone);
    if (!phone)
        throw challenge.fail('PHONE_INVALID', 'يلزم رقم هاتف ليبي مسجّل يبدأ بـ091 أو 092 أو 093 أو 094.');
    if (!transport.configured())
        throw challenge.fail('UNAVAILABLE', 'إرسال رسائل SMS غير متاح حاليًا.', 503);
    if (actor.otpDeliveryChannel === 'sms') {
        if (verifiedSmsPhone(actor)) return { stage: 'complete', phone: maskSmsPhone(phone) };
        throw challenge.fail('PHONE_CHANGED', 'تغير الرقم المرتبط بالتحقق. تواصل مع الدعم لتحديث طريقة الدخول.', 409);
    }
    const item = challenge.pending(actor, ctx.sessionId, {
        phoneHash: phoneProof(phone),
        stage: ['email', 'telegram'].includes(actor.otpDeliveryChannel) ? 'sending-current' : 'sending-sms',
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
    const item = actor.smsOtpEnrollment;
    const phone = normalizeSmsLoginPhone(actor.phone);
    if (!challenge.valid(item, actor, ctx.sessionId) || !phone || item.phoneHash !== phoneProof(phone)
        || !['current', 'sms'].includes(item.stage))
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
    if (item.stage === 'current') {
        const next = { ...item, stage: 'sending-sms', attempts: 0, issuedAt: Date.now(), expiresAt: Date.now() + 300000 };
        delete next.hash;
        const reserved = await Model.updateOne(guard, { $set: { smsOtpEnrollment: next } });
        if (!reserved.modifiedCount) throw changed();
        return deliver(ctx, next, phone);
    }
    const enabled = await Model.updateOne(guard, {
        $set: { otpDeliveryChannel: 'sms', smsOtpVerifiedPhoneHash: item.phoneHash, ...approval.grant(actor, 'sms') },
        $inc: { emailOtpSettingsRevision: 1 },
        $unset: { smsOtpEnrollment: 1, emailOtpEnrollment: 1, telegramOtpEnrollment: 1, loginChannelAction: 1, ...challenge.unsetLogin },
    });
    if (!enabled.modifiedCount) throw changed();
    return { stage: 'complete', phone: maskSmsPhone(phone) };
};

module.exports = { present, start, confirm };
