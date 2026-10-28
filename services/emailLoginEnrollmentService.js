'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const {
    normalizeOtpEmail,
    isValidOtpEmail,
    resolveAccountOtpEmail,
    isEmailOtpEnabled,
} = require('../utils/otpDeliveryChannel');
const mailer = require('./emailLoginEnrollmentMailer');
const { normalizeSubmittedOtp } = require('../utils/otp');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const digest = (value) =>
    crypto
        .createHmac('sha256', process.env.SESSION_SECRET || process.env.JWT_SECRET)
        .update(value)
        .digest('hex');
const revisionFilter = (actor) => ({
    $or: [
        { emailOtpSettingsRevision: actor.emailOtpSettingsRevision || 0 },
        ...(!(actor.emailOtpSettingsRevision || 0) ? [{ emailOtpSettingsRevision: { $exists: false } }] : []),
    ],
});
const credentialFilter = (actor) => ({
    _id: actor._id,
    status: 'active',
    webPassword: actor.webPassword,
    ...revisionFilter(actor),
});
const binding = (actor, sessionId) => digest(`${actor._id}:${sessionId}:${actor.webPassword}`);
const targetEmail = ({ actor, profileEmail, isOwner }) =>
    normalizeOtpEmail(isOwner ? profileEmail : actor.email);
const present = (ctx) => ({
    enabled: ctx.actor.otpDeliveryChannel === 'email',
    selectedChannel: ctx.actor.otpDeliveryChannel,
    email: maskEmail(resolveAccountOtpEmail(ctx.actor)),
    targetEmail: maskEmail(targetEmail(ctx)),
    hasEmail: isValidOtpEmail(targetEmail(ctx)),
    verified: Boolean(ctx.actor.emailOtpVerifiedAt),
    canSend: isEmailOtpEnabled() && mailer.configured(),
    isOwner: ctx.isOwner,
    canChangeEmail: targetEmail(ctx) !== resolveAccountOtpEmail(ctx.actor),
});
const maskEmail = (value) => {
    const [name, host] = String(value || '').split('@');
    return host ? `${name.slice(0, 2)}***@${host}` : '';
};
const start = async (ctx) => {
    const { actor, Model, sessionId, password } = ctx;
    if (
        typeof password !== 'string' ||
        password.length > 128 ||
        !(await bcrypt.compare(password, actor.webPassword || ''))
    )
        throw fail('PASSWORD', 'كلمة المرور الحالية غير صحيحة.', 403);
    const email = targetEmail(ctx);
    if (!isValidOtpEmail(email))
        throw fail('PROFILE_EMAIL_REQUIRED', 'أضف بريدًا صالحًا إلى بيانات الحساب أولًا.');
    if (!isEmailOtpEnabled() || !mailer.configured())
        throw fail('SMTP_UNAVAILABLE', 'إرسال البريد غير متاح حاليًا. تواصل مع الإدارة.', 503);
    const now = Date.now(),
        id = crypto.randomUUID(),
        code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const pending = {
        id,
        email,
        revision: actor.emailOtpSettingsRevision || 0,
        binding: binding(actor, sessionId),
        hash: digest(`${id}:${code}`),
        attempts: 0,
        issuedAt: now,
        expiresAt: now + 300000,
        delivered: false,
    };
    const reserved = await Model.updateOne(
        {
            ...credentialFilter(actor),
            $and: [
                {
                    $or: [
                        { 'emailOtpEnrollment.issuedAt': { $lte: now - 60000 } },
                        { 'emailOtpEnrollment.issuedAt': { $exists: false } },
                    ],
                },
            ],
        },
        { $set: { emailOtpEnrollment: pending } }
    );
    if (!reserved.modifiedCount)
        throw fail(
            'COOLDOWN_OR_CHANGED',
            'انتظر دقيقة قبل إعادة الإرسال، أو حدّث الصفحة إذا تغيرت الإعدادات.',
            409
        );
    try {
        await mailer.sendCode(email, code, { kind: ctx.kind, accountName: actor.name });
    } catch (_) {
        // Keep the cooldown on failed delivery; the undelivered code cannot activate protection.
        throw fail('EMAIL_SEND_FAILED', 'تعذر إرسال الكود. حاول بعد دقيقة.', 503);
    }
    const delivered = await Model.updateOne(
        { ...credentialFilter(actor), 'emailOtpEnrollment.id': id },
        { $set: { 'emailOtpEnrollment.delivered': true } }
    );
    if (!delivered.modifiedCount) throw fail('CHANGED', 'تغيرت إعدادات الأمان. ابدأ من جديد.', 409);
    return { email: maskEmail(email), expiresAt: pending.expiresAt, resendAt: now + 60000 };
};
const confirm = async (ctx) => {
    const { actor, Model, sessionId } = ctx;
    if (!isEmailOtpEnabled() || !mailer.configured())
        throw fail('SMTP_UNAVAILABLE', 'إرسال البريد غير متاح حاليًا. تواصل مع الإدارة.', 503);
    const pending = actor.emailOtpEnrollment;
    if (
        !pending ||
        !pending.delivered ||
        pending.revision !== (actor.emailOtpSettingsRevision || 0) ||
        pending.expiresAt <= Date.now() ||
        pending.binding !== binding(actor, sessionId) ||
        pending.email !== targetEmail(ctx)
    )
        throw fail('EXPIRED', 'انتهى الكود أو تغير البريد أو كلمة المرور. ابدأ من جديد.', 410);
    const guard = {
        ...credentialFilter(actor),
        'emailOtpEnrollment.id': pending.id,
        'emailOtpEnrollment.delivered': true,
        'emailOtpEnrollment.attempts': { $lt: 5 },
        'emailOtpEnrollment.expiresAt': { $gt: Date.now() },
    };
    const attempt = await Model.updateOne(guard, { $inc: { 'emailOtpEnrollment.attempts': 1 } });
    if (!attempt.modifiedCount)
        throw fail('ATTEMPTS', 'انتهت محاولات الكود أو تغير الإعداد. اطلب كودًا جديدًا.', 410);
    const code = typeof ctx.code === 'string' && ctx.code.length <= 64 ? normalizeSubmittedOtp(ctx.code) : '';
    if (
        !/^\d{6}$/.test(code) ||
        !crypto.timingSafeEqual(Buffer.from(digest(`${pending.id}:${code}`)), Buffer.from(pending.hash))
    )
        throw fail('CODE', 'كود التحقق غير صحيح.');
    // The document update consumes the challenge and enables the canonical admin/login flag atomically.
    delete guard['emailOtpEnrollment.attempts'];
    const set = {
        otpDeliveryChannel: actor.otpDeliveryChannel === 'telegram' ? 'telegram' : 'email',
        emailOtpVerifiedEmail: pending.email,
        emailOtpVerifiedAt: new Date(),
    };
    if (!(ctx.isOwner && ctx.kind === 'agent')) set.email = pending.email;
    const result = await Model.updateOne(guard, {
        $set: set,
        $inc: { emailOtpSettingsRevision: 1 },
        $unset: {
            emailOtpEnrollment: 1,
            otpCode: 1,
            otpChallengeId: 1,
            otpExpires: 1,
            otpIssuedAt: 1,
            otpAttempts: 1,
        },
    });
    if (!result.modifiedCount) throw fail('CHANGED', 'تغيرت إعدادات الأمان. ابدأ من جديد.', 409);
    return { enabled: set.otpDeliveryChannel === 'email', verified: true };
};
module.exports = { start, confirm, present, targetEmail };
