'use strict';
const Challenge = require('../models/BusinessLoginChallenge');
const User = require('../models/User');
const CompanyEmployee = require('../models/ClientEmployee');
const Staff = require('../models/AgentEmployee');
const Company = require('../models/ClientCompany');
const {
    resolveAccountOtpEmail,
    isValidOtpEmail,
    isEmailOtpEnabled,
    isLoginOtpEnabledForAccount,
} = require('../utils/otpDeliveryChannel');
const { getSmtpConfig, getMissingSmtpSettings, sendLoginOtpEmail } = require('./emailOtpMailer');
const telegram = require('./telegramLoginTransport');
const proof = require('../utils/emailLoginMfaProof');
const { establishAuthenticatedSession } = require('../utils/sessionSecurity');
const { hash, guard, fail } = require('../utils/loginSecurityChallenge');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otp');
const { tenantMode } = require('../middlewares/tenantResolver');
const approval = require('../utils/loginMethodApproval');
const registry = {
    user: User,
    company: CompanyEmployee,
    agent_staff: Staff,
    sub_client: require('../models/SubAccount'),
};
const isBusiness = (actor, type) =>
    ['company', 'agent_staff', 'sub_client'].includes(type) || (type === 'user' && Boolean(actor));
const fingerprint = (actor) =>
    hash(
        JSON.stringify([
            String(actor._id),
            actor.webPassword,
            actor.status,
            actor.sessionVersion || 0,
            actor.emailOtpSettingsRevision || 0,
            actor.otpDeliveryChannel,
            resolveAccountOtpEmail(actor),
            actor.emailOtpVerifiedAt || null,
            actor.telegramLoginVerifiedAt || null,
            actor.telegramLoginBotId || '',
            actor.telegramLoginChatId || '',
            actor.emailOtpLoginApprovedFor || '',
            actor.telegramLoginApprovedFor || '',
            Boolean(actor.mfaEnabled),
            actor.mfaType || 'none',
            actor.mfaConfiguredAt || null,
            String(actor.tenantId || ''),
            String(actor.companyId || actor.agentId || ''),
            String(actor.masterId || ''),
            actor.masterType || '',
        ])
    );
const sessionBinding = (req) => hash('business-otp:' + req.sessionID);
const maskEmail = (email) => {
    const [local, host] = email.split('@');
    return host ? local.slice(0, 2) + '***@' + host : '';
};
const methods = (actor) => {
    const result = [],
        email = resolveAccountOtpEmail(actor);
    if (approval.emailAllowed(actor) && isValidOtpEmail(email))
        result.push({
            key: 'email',
            title: 'البريد الإلكتروني',
            destination: maskEmail(email),
            available: isEmailOtpEnabled() && getMissingSmtpSettings(getSmtpConfig()).length === 0,
        });
    if (actor.telegramLoginVerifiedAt && actor.telegramLoginChatId && approval.telegramAllowed(actor))
        result.push({
            key: 'telegram',
            title: 'تليجرام',
            destination: actor.telegramLoginUsername
                ? '@' + actor.telegramLoginUsername.slice(0, 2) + '***'
                : 'حساب تليجرام المؤكد',
            available: telegram.configured() && actor.telegramLoginBotId === telegram.config().botId,
        });
    return result;
};
const loadActor = async (req, type, id) => {
    const Model = registry[type];
    if (!Model) throw fail('SESSION_EXPIRED', 'انتهت محاولة الدخول. أدخل كلمة المرور من جديد.', 401);
    const actor = await Model.findById(id).select('+telegramLoginChatId +loginOtpLastSentAt').lean();
    if (
        !actor ||
        actor.status !== 'active' ||
        !isBusiness(actor, type) ||
        !isLoginOtpEnabledForAccount(actor)
    )
        throw fail('ACCOUNT_CHANGED', 'تغيرت حالة الحساب. سجل الدخول من جديد.', 401);
    if (
        tenantMode() === 'multi' &&
        (!req.tenant?._id || String(actor.tenantId || '') !== String(req.tenant._id))
    )
        throw fail('SESSION_EXPIRED', 'انتهت محاولة الدخول.', 401);
    if (type === 'company') {
        const parent = await Company.findById(actor.companyId).select('status tenantId').lean();
        if (
            !parent ||
            parent.status !== 'active' ||
            (tenantMode() === 'multi' && String(parent.tenantId || '') !== String(actor.tenantId || ''))
        )
            throw fail('ACCOUNT_CHANGED', 'حساب الشركة غير متاح حاليًا.', 401);
    } else if (type === 'agent_staff') {
        const parent = await User.findById(actor.agentId).select('status role tenantId').lean();
        if (
            !parent ||
            parent.status !== 'active' ||
            parent.role !== 'agent' ||
            String(parent.tenantId || '') !== String(actor.tenantId || '')
        )
            throw fail('ACCOUNT_CHANGED', 'حساب الوكالة غير متاح حاليًا.', 401);
    }
    if (type === 'sub_client') {
        const Parent = actor.masterType === 'company' ? Company : User;
        const parent = await Parent.findById(actor.masterId).select('status tenantId').lean();
        if (
            !parent ||
            parent.status !== 'active' ||
            (tenantMode() === 'multi' && String(parent.tenantId || '') !== String(actor.tenantId || ''))
        )
            throw fail('ACCOUNT_CHANGED', 'الحساب الرئيسي غير متاح.', 401);
    }
    if (
        actor.mfaEnabled &&
        actor.mfaType === 'totp' &&
        !proof.valid(req.session.pendingEmailMfaProof, actor, type)
    )
        throw fail('MFA_REQUIRED', 'أكمل التحقق من Authenticator بتسجيل الدخول مجددًا.', 401);
    return { actor, Model };
};
const start = async (req, actor, type, values) => {
    await establishAuthenticatedSession(req, {
        ...values,
        tempClientId: actor._id,
        tempAccountType: type,
    });
    const current = await loadActor(req, type, actor._id);
    const expires =
        current.actor.mfaEnabled && current.actor.mfaType === 'totp'
            ? Math.min(Date.now() + 600000, req.session.pendingEmailMfaProof.expiresAt)
            : Date.now() + 600000;
    const record = await Challenge.create({
        actorId: actor._id,
        actorModel: current.Model.modelName,
        accountType: type,
        binding: sessionBinding(req),
        fingerprint: fingerprint(current.actor),
        expiresAt: new Date(expires),
    });
    req.session.businessOtpChallengeId = String(record._id);
    return record;
};
const load = async (req) => {
    const record =
        req.session?.businessOtpChallengeId &&
        (await Challenge.findById(req.session.businessOtpChallengeId)
            .select('+binding +fingerprint +codeHash')
            .lean());
    if (
        !record ||
        record.binding !== sessionBinding(req) ||
        record.expiresAt <= new Date() ||
        ['used', 'locked'].includes(record.state) ||
        String(record.actorId) !== String(req.session.tempClientId) ||
        record.accountType !== req.session.tempAccountType
    )
        throw fail('SESSION_EXPIRED', 'انتهت محاولة الدخول. أدخل كلمة المرور من جديد.', 401);
    const current = await loadActor(req, record.accountType, record.actorId);
    if (fingerprint(current.actor) !== record.fingerprint)
        throw fail('ACCOUNT_CHANGED', 'تغيرت إعدادات الأمان. سجل الدخول من جديد.', 401);
    return { ...current, record };
};
const present = ({ actor, record }) => ({
    methods: methods(actor),
    selected: record.channel || null,
    preferred: actor.otpDeliveryChannel,
    stage: record.state,
    expiresAt: record.codeExpiresAt || null,
    sessionExpiresAt: record.expiresAt,
    resendAt: actor.loginOtpLastSentAt
        ? new Date(new Date(actor.loginOtpLastSentAt).getTime() + 60000)
        : null,
    authenticatorVerified: Boolean(actor.mfaEnabled && actor.mfaType === 'totp'),
    telegramUrl: `https://t.me/${telegram.config().username}`,
});
const view = async (req) => present(await load(req));
const send = async (req, channel) => {
    const ctx = await load(req),
        { actor, Model, record } = ctx;
    if (!methods(actor).some((method) => method.key === channel && method.available))
        throw fail('METHOD_UNAVAILABLE', 'هذه الطريقة غير مفعلة أو الإرسال غير متاح حاليًا.');
    if (record.expiresAt.getTime() - Date.now() < 60000)
        throw fail('SESSION_EXPIRED', 'انتهت مهلة إرسال كود جديد. سجل الدخول مجددًا.', 401);
    const now = new Date(),
        expiresAt = new Date(Math.min(now.getTime() + 300000, record.expiresAt.getTime())),
        expiresMinutes = Math.ceil((expiresAt.getTime() - now.getTime()) / 60000);
    const reserved = await Model.updateOne(
        {
            ...guard(actor),
            otpDeliveryChannel: actor.otpDeliveryChannel,
            $and: [
                {
                    $or: [
                        { loginOtpLastSentAt: { $lte: new Date(now.getTime() - 60000) } },
                        { loginOtpLastSentAt: { $exists: false } },
                    ],
                },
            ],
        },
        { $set: { loginOtpLastSentAt: now } }
    );
    if (!reserved.modifiedCount)
        throw fail('COOLDOWN', 'انتظر دقيقة بين طلبات الإرسال، حتى عند تغيير الطريقة.', 429);
    const code = generateOtp(),
        generation = record.generation + 1;
    const claimed = await Challenge.updateOne(
        {
            _id: record._id,
            binding: sessionBinding(req),
            generation: record.generation,
            state: { $in: ['choose', 'sent'] },
            expiresAt: { $gt: now },
        },
        {
            $set: {
                state: 'sending',
                channel,
                codeHash: hashOtp(code, 'business-login:' + record._id + ':' + generation),
                codeExpiresAt: expiresAt,
                attempts: 0,
                resendAt: new Date(now.getTime() + 60000),
            },
            $inc: { generation: 1 },
        }
    );
    if (!claimed.modifiedCount) throw fail('CHANGED', 'تغيرت محاولة الدخول. حدّث الصفحة.', 409);
    let success = false;
    try {
        const fresh = await loadActor(req, record.accountType, actor._id);
        if (fingerprint(fresh.actor) !== record.fingerprint) throw new Error('CHANGED');
        if (channel === 'telegram') {
            await telegram.sendCode(fresh.actor.telegramLoginChatId, code, 'login', expiresMinutes);
            success = true;
        } else {
            const result = await sendLoginOtpEmail({
                to: resolveAccountOtpEmail(fresh.actor),
                otp: code,
                expiresMinutes,
                expiresAt,
                accountName: actor.name || '',
                emailDesignScope:
                    record.accountType === 'company'
                        ? 'company'
                        : actor.role === 'agent' || record.accountType === 'agent_staff'
                          ? 'agent'
                          : 'customer',
                attemptAt: now,
                userAgent: req.get?.('user-agent') || '',
                loginAccount: req.session.pendingSecurityUsername || '',
            });
            success = result?.success === true;
        }
    } catch (_) {
        /* Keep transport errors and credentials out of the response. */
    }
    const sentGuard = {
        _id: record._id,
        binding: sessionBinding(req),
        generation,
        state: 'sending',
    };
    if (!success) {
        await Challenge.updateOne(sentGuard, {
            $set: { state: 'choose' },
            $unset: { codeHash: 1, channel: 1, codeExpiresAt: 1 },
        });
        throw fail(
            'DELIVERY_FAILED',
            'تعذر إرسال الكود. اختر طريقة متاحة وحاول بعد دقيقة؛ لم يكتمل الدخول.',
            503
        );
    }
    const sent = await Challenge.updateOne(sentGuard, {
        $set: { state: 'sent' },
    });
    if (!sent.modifiedCount)
        throw fail('CHANGED', 'تم تغيير الطريقة أو إلغاء هذا الكود. أرسل كودًا جديدًا.', 409);
    return view(req);
};
const change = async (req) => {
    const { record } = await load(req);
    const result = await Challenge.updateOne(
        {
            _id: record._id,
            binding: sessionBinding(req),
            generation: record.generation,
            state: { $in: ['choose', 'sending', 'sent'] },
        },
        {
            $set: { state: 'choose', attempts: 0 },
            $unset: { channel: 1, codeHash: 1, codeExpiresAt: 1 },
            $inc: { generation: 1 },
        }
    );
    if (!result.modifiedCount) throw fail('CHANGED', 'تغيرت محاولة الدخول. حدّث الصفحة.', 409);
    return view(req);
};
const consume = async (req, code) => {
    const ctx = await load(req),
        { record } = ctx;
    if (record.state !== 'sent' || !record.codeExpiresAt || record.codeExpiresAt <= new Date())
        throw fail('CODE_EXPIRED', 'انتهت صلاحية الكود أو لم يُرسل بعد. اطلب كودًا جديدًا.');
    const attempted = await Challenge.findOneAndUpdate(
        {
            _id: record._id,
            binding: sessionBinding(req),
            state: 'sent',
            generation: record.generation,
            attempts: { $lt: 5 },
            codeExpiresAt: { $gt: new Date() },
        },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' }
    )
        .select('+codeHash')
        .lean();
    if (!attempted) throw fail('ATTEMPTS', 'انتهت محاولات التحقق. سجل الدخول مجددًا.', 401);
    if (
        typeof code !== 'string' ||
        code.length > 64 ||
        !verifyOtp(code, attempted.codeHash, 'business-login:' + record._id + ':' + record.generation)
    ) {
        if (attempted.attempts >= 5)
            await Challenge.updateOne(
                { _id: record._id, generation: record.generation, state: 'sent' },
                { $set: { state: 'locked' }, $unset: { codeHash: 1 } }
            );
        throw fail('CODE_INVALID', 'الكود غير صحيح. تحقق من آخر رسالة والطريقة المختارة.');
    }
    // Re-read credentials and factor state after any delivery/typing delay.
    const fresh = await load(req);
    const consumed = await Challenge.updateOne(
        {
            _id: record._id,
            binding: sessionBinding(req),
            state: 'sent',
            generation: record.generation,
            codeHash: attempted.codeHash,
            codeExpiresAt: { $gt: new Date() },
        },
        { $set: { state: 'used' }, $unset: { codeHash: 1 } }
    );
    if (!consumed.modifiedCount)
        throw fail('CODE_USED', 'تم استخدام الكود أو تغيير الطريقة. سجل الدخول من جديد.', 401);
    return {
        account: fresh.actor,
        accountType: record.accountType,
        channel: record.channel,
        authenticatorVerified: Boolean(fresh.actor.mfaEnabled && fresh.actor.mfaType === 'totp'),
    };
};
module.exports = { isBusiness, start, view, send, change, consume };
