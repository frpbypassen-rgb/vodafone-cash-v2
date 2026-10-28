'use strict';
const crypto = require('node:crypto');
const transport = require('./telegramLoginTransport');
const challenge = require('../utils/loginSecurityChallenge');
const { normalizeSubmittedOtp } = require('../utils/otp');
const { models } = require('./businessLoginSecurityContext');
const { resolveAccountOtpEmail, isValidOtpEmail, isEmailOtpEnabled } = require('../utils/otpDeliveryChannel');
const email = require('./emailLoginEnrollmentMailer');
const modelNames = ['User', 'ClientEmployee', 'AgentEmployee'];
const key = () =>
    crypto
        .createHash('sha256')
        .update('telegram-login-link-v1:' + challenge.secret())
        .digest();
const encodeLink = (Model, id) => {
    const iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const value = Buffer.concat([
        Buffer.from([modelNames.indexOf(Model.modelName)]),
        Buffer.from(String(id), 'hex'),
    ]);
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return 'TL1' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
};
const decodeLink = (token) => {
    if (!/^TL1[A-Za-z0-9_-]{55}$/.test(token)) return null;
    try {
        const bytes = Buffer.from(token.slice(3), 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const value = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
        if (value.length !== 13 || !modelNames[value[0]]) return null;
        return { Model: models[modelNames[value[0]]], id: value.subarray(1).toString('hex') };
    } catch (_) {
        return null;
    }
};
const credential = (actor) => challenge.hash(`${actor.webPassword}:${actor.sessionVersion || 0}`);
const telegramReady = (actor) =>
    Boolean(
        transport.configured() &&
        actor.telegramLoginVerifiedAt &&
        actor.telegramLoginChatId &&
        actor.telegramLoginBotId === transport.config().botId
    );
const emailReady = (actor) =>
    Boolean(
        actor.emailOtpVerifiedAt &&
        isValidOtpEmail(resolveAccountOtpEmail(actor)) &&
        isEmailOtpEnabled() &&
        email.configured()
    );
const present = (ctx) => {
    const actor = ctx.actor,
        pending = actor.telegramOtpEnrollment;
    const waiting = challenge.valid(pending, actor, ctx.sessionId);
    return {
        selected: ['email', 'telegram'].includes(actor.otpDeliveryChannel) ? actor.otpDeliveryChannel : 'off',
        linked: Boolean(actor.telegramLoginVerifiedAt),
        linkedAt: actor.telegramLoginVerifiedAt || null,
        accountLabel: actor.telegramLoginUsername
            ? '@' + actor.telegramLoginUsername
            : actor.telegramLoginVerifiedAt
              ? 'حساب تليجرام مؤكّد'
              : '',
        configured: transport.configured(),
        emailReady: emailReady(actor),
        telegramReady: telegramReady(actor),
        stage: waiting ? pending.stage : null,
        expiresAt: waiting ? pending.expiresAt : null,
    };
};
const start = async (ctx) => {
    const { actor, Model } = ctx;
    await challenge.password(actor, ctx.password);
    if (!transport.configured())
        throw challenge.fail('NOT_CONFIGURED', 'بوت أكواد الدخول غير مهيأ حاليًا. تواصل مع الإدارة.', 503);
    if (actor.telegramLoginVerifiedAt && actor.otpDeliveryChannel === 'telegram')
        throw challenge.fail(
            'SELECT_EMAIL_FIRST',
            'اختر البريد المؤكد أولًا قبل تغيير حساب تليجرام المرتبط.',
            409
        );
    const link = encodeLink(Model, actor._id);
    const pending = challenge.pending(actor, ctx.sessionId, {
        linkHash: challenge.hash(link),
        botId: transport.config().botId,
        credential: credential(actor),
        stage: 'waiting',
    });
    const result = await Model.updateOne(
        {
            ...challenge.guard(actor),
            $and: [
                {
                    $or: [
                        { 'telegramOtpEnrollment.issuedAt': { $lte: Date.now() - 60000 } },
                        { 'telegramOtpEnrollment.issuedAt': { $exists: false } },
                    ],
                },
            ],
        },
        { $set: { telegramOtpEnrollment: pending } }
    );
    if (!result.modifiedCount)
        throw challenge.fail('COOLDOWN', 'انتظر دقيقة أو حدّث الصفحة إذا تغيرت الإعدادات.', 409);
    return { url: `https://t.me/${transport.config().username}?start=${link}`, expiresAt: pending.expiresAt };
};
const handleStart = async ({ token, chatId, userId, username }) => {
    const target = decodeLink(token);
    if (
        !target ||
        !transport.configured() ||
        !/^[1-9]\d{0,18}$/.test(String(chatId)) ||
        String(chatId) !== String(userId)
    )
        return false;
    const actor = await target.Model.findById(target.id).select('+telegramOtpEnrollment');
    const pending = actor?.telegramOtpEnrollment;
    if (
        !actor ||
        actor.status !== 'active' ||
        !pending ||
        pending.stage !== 'waiting' ||
        pending.expiresAt <= Date.now() ||
        pending.botId !== transport.config().botId ||
        pending.revision !== challenge.revision(actor) ||
        pending.credential !== credential(actor) ||
        !challenge.matches(pending.linkHash, token)
    )
        return false;
    const code = challenge.code();
    const guard = {
        ...challenge.guard(actor),
        'telegramOtpEnrollment.id': pending.id,
        'telegramOtpEnrollment.stage': 'waiting',
        'telegramOtpEnrollment.expiresAt': { $gt: Date.now() },
    };
    const claimed = await target.Model.updateOne(guard, {
        $set: {
            'telegramOtpEnrollment.stage': 'sending',
            'telegramOtpEnrollment.expiresAt': Date.now() + 300000,
            'telegramOtpEnrollment.chatId': String(chatId),
            'telegramOtpEnrollment.userId': String(userId),
            'telegramOtpEnrollment.username': /^[A-Za-z0-9_]{1,32}$/.test(String(username || ''))
                ? String(username)
                : '',
            'telegramOtpEnrollment.codeHash': challenge.hash(`tg-bind:${pending.id}:${code}`),
        },
    });
    if (!claimed.modifiedCount) return false;
    try {
        await transport.sendCode(chatId, code, 'enrollment');
    } catch (_) {
        await target.Model.updateOne(
            { ...challenge.guard(actor), 'telegramOtpEnrollment.id': pending.id },
            { $set: { 'telegramOtpEnrollment.stage': 'send_failed' } }
        );
        return false;
    }
    const sent = await target.Model.updateOne(
        {
            ...challenge.guard(actor),
            'telegramOtpEnrollment.id': pending.id,
            'telegramOtpEnrollment.stage': 'sending',
        },
        { $set: { 'telegramOtpEnrollment.stage': 'delivered' } }
    );
    return Boolean(sent.modifiedCount);
};
const confirm = async (ctx) => {
    const { actor, Model } = ctx,
        pending = actor.telegramOtpEnrollment;
    if (
        !challenge.valid(pending, actor, ctx.sessionId) ||
        pending.stage !== 'delivered' ||
        pending.botId !== transport.config().botId ||
        !transport.configured()
    )
        throw challenge.fail('EXPIRED', 'انتهى الربط أو لم يصل كود التأكيد بعد. ابدأ من جديد.', 410);
    const guard = {
        ...challenge.guard(actor),
        'telegramOtpEnrollment.id': pending.id,
        'telegramOtpEnrollment.stage': 'delivered',
        'telegramOtpEnrollment.expiresAt': { $gt: Date.now() },
    };
    const attempt = await Model.updateOne(
        { ...guard, 'telegramOtpEnrollment.attempts': { $lt: 5 } },
        { $inc: { 'telegramOtpEnrollment.attempts': 1 } }
    );
    if (!attempt.modifiedCount)
        throw challenge.fail('ATTEMPTS', 'انتهت المحاولات أو تغيرت الإعدادات. ابدأ من جديد.', 410);
    const code = typeof ctx.code === 'string' && ctx.code.length <= 64 ? normalizeSubmittedOtp(ctx.code) : '';
    if (!/^\d{6}$/.test(code) || !challenge.matches(pending.codeHash, `tg-bind:${pending.id}:${code}`))
        throw challenge.fail('CODE', 'كود التأكيد غير صحيح.');
    const selected = ['email', 'telegram'].includes(actor.otpDeliveryChannel)
        ? actor.otpDeliveryChannel
        : 'telegram';
    const result = await Model.updateOne(guard, {
        $set: {
            telegramLoginChatId: pending.chatId,
            telegramLoginUserId: pending.userId,
            telegramLoginUsername: pending.username || '',
            telegramLoginBotId: pending.botId,
            telegramLoginVerifiedAt: new Date(),
            otpDeliveryChannel: selected,
        },
        $inc: { emailOtpSettingsRevision: 1 },
        $unset: {
            telegramOtpEnrollment: 1,
            loginChannelAction: 1,
            emailOtpEnrollment: 1,
            ...challenge.unsetLogin,
        },
    });
    if (!result.modifiedCount) throw challenge.fail('CHANGED', 'تغيرت الإعدادات. حدّث الصفحة.', 409);
    return { linked: true, selected };
};
const sendCurrent = async (ctx, code, purpose = 'channel') => {
    if (ctx.actor.otpDeliveryChannel === 'telegram') {
        if (!telegramReady(ctx.actor)) throw new Error('TELEGRAM_LOGIN_UNAVAILABLE');
        return transport.sendCode(ctx.actor.telegramLoginChatId, code, purpose);
    }
    if (
        ctx.actor.otpDeliveryChannel === 'email' &&
        isEmailOtpEnabled() &&
        email.configured() &&
        isValidOtpEmail(resolveAccountOtpEmail(ctx.actor))
    )
        return email.sendCode(resolveAccountOtpEmail(ctx.actor), code, {
            kind: ctx.kind,
            accountName: ctx.actor.name,
            purpose: 'channel',
        });
    throw new Error('CURRENT_CHANNEL_UNAVAILABLE');
};
const assertTarget = (actor, target) => {
    if (target === 'email' && emailReady(actor)) return;
    if (target === 'telegram' && telegramReady(actor)) return;
    if (target === 'unlink' && actor.otpDeliveryChannel !== 'telegram') return;
    throw challenge.fail(
        'TARGET_NOT_READY',
        'أكّد القناة المطلوبة وهيّئ الإرسال أولًا. لإزالة تليجرام اختر البريد المؤكد قبل ذلك.'
    );
};
const applyTarget = async (ctx, target, extraGuard = {}) => {
    assertTarget(ctx.actor, target);
    const result = await ctx.Model.updateOne(
        { ...challenge.guard(ctx.actor), ...extraGuard },
        {
            ...(target === 'unlink' ? {} : { $set: { otpDeliveryChannel: target } }),
            $inc: { emailOtpSettingsRevision: 1 },
            $unset: {
                loginChannelAction: 1,
                telegramOtpEnrollment: 1,
                emailOtpEnrollment: 1,
                ...challenge.unsetLogin,
                ...(target === 'unlink'
                    ? {
                          telegramLoginChatId: 1,
                          telegramLoginUserId: 1,
                          telegramLoginUsername: 1,
                          telegramLoginBotId: 1,
                          telegramLoginVerifiedAt: 1,
                      }
                    : {}),
            },
        }
    );
    if (!result.modifiedCount) throw challenge.fail('CHANGED', 'تغيرت إعدادات الحساب. حدّث الصفحة.', 409);
    return { completed: true, selected: target === 'unlink' ? ctx.actor.otpDeliveryChannel : target };
};
const requestChannel = async (ctx) => {
    await challenge.password(ctx.actor, ctx.password);
    assertTarget(ctx.actor, ctx.target);
    if (ctx.target === ctx.actor.otpDeliveryChannel) return { completed: true, selected: ctx.target };
    if (!['email', 'telegram'].includes(ctx.actor.otpDeliveryChannel)) return applyTarget(ctx, ctx.target);
    const code = challenge.code(),
        pending = challenge.pending(ctx.actor, ctx.sessionId, { target: ctx.target, delivered: false });
    pending.hash = challenge.hash(`channel:${pending.id}:${code}`);
    const reserved = await ctx.Model.updateOne(
        {
            ...challenge.guard(ctx.actor),
            $and: [
                {
                    $or: [
                        { 'loginChannelAction.issuedAt': { $lte: Date.now() - 60000 } },
                        { 'loginChannelAction.issuedAt': { $exists: false } },
                    ],
                },
            ],
        },
        { $set: { loginChannelAction: pending } }
    );
    if (!reserved.modifiedCount) throw challenge.fail('COOLDOWN', 'انتظر دقيقة أو حدّث الصفحة.', 409);
    try {
        await sendCurrent(ctx, code);
    } catch (_) {
        throw challenge.fail(
            'SEND_FAILED',
            'تعذر إرسال كود التأكيد إلى القناة الحالية. لم تتغير قناة الدخول.',
            503
        );
    }
    const sent = await ctx.Model.updateOne(
        { ...challenge.guard(ctx.actor), 'loginChannelAction.id': pending.id },
        { $set: { 'loginChannelAction.delivered': true } }
    );
    if (!sent.modifiedCount) throw challenge.fail('CHANGED', 'تغيرت إعدادات الأمان. ابدأ من جديد.', 409);
    return { requiresCode: true, source: ctx.actor.otpDeliveryChannel, expiresAt: pending.expiresAt };
};
const confirmChannel = async (ctx) => {
    const pending = ctx.actor.loginChannelAction;
    if (!challenge.valid(pending, ctx.actor, ctx.sessionId) || !pending.delivered)
        throw challenge.fail('EXPIRED', 'انتهى طلب تغيير القناة. ابدأ من جديد.', 410);
    const guard = {
        'loginChannelAction.id': pending.id,
        'loginChannelAction.expiresAt': { $gt: Date.now() },
        'loginChannelAction.delivered': true,
    };
    const attempt = await ctx.Model.updateOne(
        { ...challenge.guard(ctx.actor), ...guard, 'loginChannelAction.attempts': { $lt: 5 } },
        { $inc: { 'loginChannelAction.attempts': 1 } }
    );
    if (!attempt.modifiedCount) throw challenge.fail('ATTEMPTS', 'انتهت المحاولات أو تغير الإعداد.', 410);
    const code = typeof ctx.code === 'string' && ctx.code.length <= 64 ? normalizeSubmittedOtp(ctx.code) : '';
    if (!/^\d{6}$/.test(code) || !challenge.matches(pending.hash, `channel:${pending.id}:${code}`))
        throw challenge.fail('CODE', 'كود تأكيد تغيير القناة غير صحيح.');
    return applyTarget(ctx, pending.target, guard);
};
const sendLoginCode = async ({ account, accountType, otp, challengeId }) => {
    const Model = { user: models.User, company: models.ClientEmployee, agent_staff: models.AgentEmployee }[
        accountType
    ];
    if (!Model)
        return {
            success: false,
            channel: 'telegram',
            provider: 'telegram',
            code: 'TELEGRAM_LOGIN_UNAVAILABLE',
        };
    const actor = await Model.findById(account._id).select('+telegramLoginChatId');
    if (
        !actor ||
        actor.status !== 'active' ||
        actor.otpDeliveryChannel !== 'telegram' ||
        challenge.revision(actor) !== challenge.revision(account) ||
        actor.otpChallengeId !== challengeId ||
        !telegramReady(actor)
    )
        return {
            success: false,
            channel: 'telegram',
            provider: 'telegram',
            code: 'TELEGRAM_LOGIN_UNAVAILABLE',
        };
    try {
        await transport.sendCode(actor.telegramLoginChatId, otp);
        return { success: true, channel: 'telegram', provider: 'telegram' };
    } catch (_) {
        return {
            success: false,
            channel: 'telegram',
            provider: 'telegram',
            code: 'TELEGRAM_LOGIN_SEND_FAILED',
        };
    }
};
module.exports = {
    present,
    start,
    handleStart,
    confirm,
    requestChannel,
    confirmChannel,
    sendLoginCode,
    telegramReady,
    emailReady,
};
