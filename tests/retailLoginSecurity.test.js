'use strict';
jest.mock('../services/emailLoginEnrollmentMailer', () => ({
    configured: jest.fn(() => true),
    sendCode: jest.fn().mockResolvedValue(),
}));
jest.mock('../services/telegramLoginTransport', () => ({
    configured: jest.fn(() => true),
    config: jest.fn(() => ({ botId: '900001', username: 'Ahram_otp_bot', ready: true })),
    sendCode: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/emailOtpMailer', () => ({
    getSmtpConfig: jest.fn(() => ({})),
    getMissingSmtpSettings: jest.fn(() => []),
    sendLoginOtpEmail: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue() }));
jest.mock('../src/Infrastructure/ResalaClient.ts', () => ({
    sendResalaPin: jest.fn().mockResolvedValue({ pin: '048291' }),
}));
const mongoose = require('mongoose'),
    { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User'),
    Sub = require('../models/SubAccount'),
    Challenge = require('../models/BusinessLoginChallenge');
const { context } = require('../services/businessLoginSecurityContext');
const email = require('../services/emailLoginEnrollmentService'),
    tg = require('../services/telegramLoginSecurityService'),
    login = require('../services/businessLoginChoiceService');
const mail = require('../services/emailLoginEnrollmentMailer'),
    transport = require('../services/telegramLoginTransport'),
    loginMailer = require('../services/emailOtpMailer');
const proof = require('../utils/emailLoginMfaProof'),
    invalidate = require('../utils/invalidateEmailLoginEnrollment');
let mongo, parent, oldTenant, oldSecret;
jest.setTimeout(120000);
beforeAll(async () => {
    oldTenant = process.env.TENANT_MODE;
    oldSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = require('node:crypto').randomBytes(32).toString('hex');
    process.env.TENANT_MODE = 'single';
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongo.getUri());
    await Challenge.init();
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    if (oldTenant === undefined) delete process.env.TENANT_MODE;
    else process.env.TENANT_MODE = oldTenant;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = oldSecret;
});
beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Sub.deleteMany({}), Challenge.deleteMany({})]);
    jest.clearAllMocks();
    parent = await User.create({
        name: 'الوكالة',
        role: 'agent',
        webUsername: 'parent',
        webPassword: 'test-password',
    });
});
const reqFor = (actor, type) => ({
    sessionID: 'enroll-session',
    session: { isClientLoggedIn: true, clientId: actor._id, accountType: type },
});
const loginReq = () => {
    const req = { sessionID: 'pre-login', get: () => '', session: {} };
    const regenerate = (cb) => {
        req.sessionID = require('crypto').randomUUID();
        req.session = { regenerate, save: (cb) => cb() };
        cb();
    };
    req.session = { regenerate, save: (cb) => cb() };
    return req;
};
const create = async (type) =>
    type === 'user'
        ? User.create({
              name: 'عميل',
              role: 'user',
              webUsername: 'customer',
              webPassword: 'test-password',
              businessProfile: { email: 'customer@example.test' },
          })
        : Sub.create({
              name: 'عميل تابع',
              masterType: 'user',
              masterId: parent._id,
              webUsername: 'sub',
              webPassword: 'test-password',
              contactEmail: 'sub@example.test',
          });
test.each(['user', 'sub_client'])(
    '%s requires password/code, shares canonical state, offers confirmed channels and preserves mandatory Authenticator',
    async (type) => {
        const actor = await create(type),
            req = reqFor(actor, type);
        let ctx = await context(req);
        const reload = async () => (ctx = await context(req));
        expect(ctx.kind).toBe('customer');
        expect(ctx.actor._id.toString()).toBe(actor._id.toString());
        await expect(email.start({ ...ctx, password: 'wrong' })).rejects.toMatchObject({ code: 'PASSWORD' });
        expect(mail.sendCode).not.toHaveBeenCalled();
        await email.start({ ...ctx, password: 'test-password' });
        const code = mail.sendCode.mock.calls.at(-1)[1];
        await reload();
        expect(ctx.actor.otpDeliveryChannel).toBe('whatsapp');
        await expect(email.confirm({ ...ctx, code: 'bad' })).rejects.toMatchObject({ code: 'CODE' });
        await email.confirm({ ...ctx, code });
        await reload();
        expect(ctx.actor.emailOtpVerifiedAt).toBeTruthy();
        expect(ctx.actor.otpDeliveryChannel).toBe('email');
        const link = await tg.start({ ...ctx, password: 'test-password' });
        const token = new URL(link.url).searchParams.get('start');
        await reload();
        expect(ctx.actor.telegramLoginVerifiedAt).toBeFalsy();
        await tg.handleStart({ token, chatId: '112233', userId: '112233', username: 'test_user' });
        const tgCode = transport.sendCode.mock.calls.at(-1)[1];
        await reload();
        expect(ctx.actor.telegramLoginVerifiedAt).toBeFalsy();
        await expect(tg.confirm({ ...ctx, code: 'bad' })).rejects.toMatchObject({ code: 'CODE' });
        await tg.confirm({ ...ctx, code: tgCode });
        await reload();
        expect(ctx.actor.telegramLoginVerifiedAt).toBeTruthy();
        await tg.requestChannel({ ...ctx, password: 'test-password', target: 'telegram' });
        const changeCode = mail.sendCode.mock.calls.at(-1)[1];
        await reload();
        await tg.confirmChannel({ ...ctx, code: changeCode });
        await reload();
        expect(ctx.actor.otpDeliveryChannel).toBe('telegram');
        ctx.actor.mfaEnabled = true;
        ctx.actor.mfaType = 'totp';
        ctx.actor.mfaConfiguredAt = new Date();
        await ctx.actor.save();
        await reload();
        await expect(login.start(loginReq(), ctx.actor, type, {})).rejects.toMatchObject({
            code: 'MFA_REQUIRED',
        });
        const attempt = loginReq();
        await login.start(attempt, ctx.actor, type, { pendingEmailMfaProof: proof.create(ctx.actor, type) });
        expect((await login.view(attempt)).methods.map((m) => m.key)).toEqual(['email', 'telegram']);
        await login.send(attempt, 'email');
        const otp = loginMailer.sendLoginOtpEmail.mock.calls.at(-1)[0].otp;
        expect(loginMailer.sendLoginOtpEmail.mock.calls.at(-1)[0].emailDesignScope).toBe('customer');
        const result = await login.consume(attempt, otp);
        expect(result.authenticatorVerified).toBe(true);
        await expect(login.consume(attempt, otp)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
        await ctx.Model.updateOne(
            { _id: ctx.actor._id },
            { $set: { loginOtpLastSentAt: new Date(Date.now() - 61000) } }
        );
        const telegramAttempt = loginReq();
        await login.start(telegramAttempt, ctx.actor, type, {
            pendingEmailMfaProof: proof.create(ctx.actor, type),
        });
        await login.send(telegramAttempt, 'telegram');
        const telegramOtp = transport.sendCode.mock.calls.at(-1)[1];
        expect((await login.consume(telegramAttempt, telegramOtp)).accountType).toBe(type);
        const next = loginReq();
        await login.start(next, ctx.actor, type, { pendingEmailMfaProof: proof.create(ctx.actor, type) });
        ctx.actor.otpDeliveryChannel = 'whatsapp';
        invalidate(ctx.actor);
        await ctx.actor.save();
        await expect(login.view(next)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
        await reload();
        expect(email.present(ctx).enabled).toBe(false);
        expect(tg.present(ctx).selected).toBe('off');
    }
);
test('inactive parent and cross-tenant access cannot start customer enrollment', async () => {
    const actor = await create('sub_client'),
        req = reqFor(actor, 'sub_client');
    parent.status = 'inactive';
    await parent.save();
    await expect(context(req)).rejects.toMatchObject({ statusCode: 403 });
    process.env.TENANT_MODE = 'multi';
    req.tenant = { _id: new mongoose.Types.ObjectId() };
    await expect(context(req)).rejects.toMatchObject({ statusCode: 401 });
    process.env.TENANT_MODE = 'single';
});

test('retail SMS verifies the registered phone before requiring a one-time login code', async () => {
    const sms = require('../services/smsLoginEnrollmentService');
    const { sendResalaPin } = require('../src/Infrastructure/ResalaClient.ts');
    const oldKey = process.env.RESALA_API_KEY;
    process.env.RESALA_API_KEY = 'rsl_test_only';
    try {
        const actor = await create('user');
        const req = reqFor(actor, 'user');
        const load = () => context(req);
        await User.updateOne({ _id: actor._id }, { $set: { phone: '0950001234' } });
        await expect(sms.start({ ...await load(), password: 'test-password' })).rejects.toMatchObject({ code: 'PHONE_INVALID' });
        expect(sendResalaPin).not.toHaveBeenCalled();
        await User.updateOne({ _id: actor._id }, { $set: { phone: '0940001234' } });
        await expect(sms.start({ ...await load(), password: 'wrong' })).rejects.toMatchObject({ code: 'PASSWORD' });
        expect(sendResalaPin).not.toHaveBeenCalled();
        await sms.start({ ...await load(), password: 'test-password', phone: '0910009999' });
        expect(sendResalaPin.mock.calls[0][0]).toBe('218940001234');
        const pending = (await load()).actor.smsOtpEnrollment;
        expect(pending.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(pending)).not.toContain('"048291"');
        await expect(sms.start({ ...await load(), password: 'test-password' })).rejects.toMatchObject({ code: 'COOLDOWN' });
        expect((await load()).actor.otpDeliveryChannel).toBe('whatsapp');
        await expect(sms.confirm({ ...await load(), code: '048291', sessionId: 'other-session' })).rejects.toMatchObject({ code: 'EXPIRED' });
        await expect(sms.confirm({ ...await load(), code: '123456' })).rejects.toMatchObject({ code: 'CODE' });
        await sms.confirm({ ...await load(), code: '048291' });
        expect((await load()).actor.otpDeliveryChannel).toBe('sms');
        await expect(sms.confirm({ ...await load(), code: '048291' })).rejects.toMatchObject({ code: 'EXPIRED' });
        sendResalaPin.mockResolvedValueOnce({ pin: '005123' });
        const attempt = loginReq();
        await login.start(attempt, (await load()).actor, 'user', {});
        expect((await login.view(attempt)).methods).toEqual([
            { key: 'sms', title: 'رسالة نصية (SMS)', destination: '094••••234', available: true },
        ]);
        await login.send(attempt, 'sms');
        const stored = await Challenge.findById(attempt.session.businessOtpChallengeId).select('+codeHash').lean();
        expect(stored.codeHash).toMatch(/^[a-f0-9]{64}$/);
        await expect(login.consume(attempt, '048291')).rejects.toMatchObject({ code: 'CODE_INVALID' });
        expect((await login.consume(attempt, '005123')).channel).toBe('sms');
        await expect(login.consume(attempt, '005123')).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
        const next = loginReq();
        await login.start(next, (await load()).actor, 'user', {});
        await User.updateOne({ _id: actor._id }, { $set: { phone: '0930001234' } });
        await expect(login.send(next, 'sms')).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
        expect(sendResalaPin).toHaveBeenCalledTimes(2);
    } finally {
        if (oldKey === undefined) delete process.env.RESALA_API_KEY;
        else process.env.RESALA_API_KEY = oldKey;
    }
});

test('switching from email to SMS requires the existing code and preserves Authenticator for login', async () => {
    const sms = require('../services/smsLoginEnrollmentService');
    const { sendResalaPin } = require('../src/Infrastructure/ResalaClient.ts');
    const oldKey = process.env.RESALA_API_KEY;
    process.env.RESALA_API_KEY = 'rsl_test_only';
    try {
        const actor = await create('sub_client');
        const req = reqFor(actor, 'sub_client');
        const load = () => context(req);
        await email.start({ ...await load(), password: 'test-password' });
        await email.confirm({ ...await load(), code: mail.sendCode.mock.calls.at(-1)[1] });
        await Sub.updateOne({ _id: actor._id }, { $set: { phone: '+218 920001234' } });
        expect((await sms.start({ ...await load(), password: 'test-password' })).stage).toBe('current');
        expect(sendResalaPin).not.toHaveBeenCalled();
        const currentPin = mail.sendCode.mock.calls.at(-1)[1];
        expect((await sms.confirm({ ...await load(), code: currentPin })).stage).toBe('sms');
        expect(sendResalaPin).toHaveBeenCalledWith('218920001234', expect.objectContaining({ len: 6 }));
        await sms.confirm({ ...await load(), code: '048291' });
        const ctx = await load();
        expect(ctx.actor.otpDeliveryChannel).toBe('sms');
        await Sub.updateOne({ _id: actor._id }, { $set: { mfaEnabled: true, mfaType: 'totp', mfaConfiguredAt: new Date() } });
        const enrolled = (await load()).actor;
        await expect(login.start(loginReq(), enrolled, 'sub_client', {})).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
        const attempt = loginReq();
        await login.start(attempt, enrolled, 'sub_client', { pendingEmailMfaProof: proof.create(enrolled, 'sub_client') });
        expect((await login.view(attempt)).methods.map(method => method.key)).toEqual(['email', 'sms']);
        sendResalaPin.mockRejectedValueOnce(new Error('provider timeout'));
        await expect(login.send(attempt, 'sms')).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
        await expect(login.consume(attempt, '048291')).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
        await expect(login.send(attempt, 'sms')).rejects.toMatchObject({ code: 'COOLDOWN' });
        expect(sendResalaPin).toHaveBeenCalledTimes(2);
    } finally {
        if (oldKey === undefined) delete process.env.RESALA_API_KEY;
        else process.env.RESALA_API_KEY = oldKey;
    }
});

test('administrator and customer read/write the same email login state', async () => {
    const actor = await create('user');
    const req = reqFor(actor, 'user');
    let ctx = await context(req);
    await email.start({ ...ctx, password: 'test-password' });
    const code = mail.sendCode.mock.calls.at(-1)[1];
    ctx = await context(req);
    await email.confirm({ ...ctx, code });
    const admin = require('../services/adminAccountManagementService');
    await expect(admin.updateEditableAccount({type:'user',id:actor._id,payload:{loginSecurityRevision:0}})).rejects.toMatchObject({code:'SETTINGS_CHANGED'});
    const disabled = await admin.updateAccountOwnerEmailOtp({
        type: 'user',
        id: actor._id,
        payload: { email: 'customer@example.test', emailOtpEnabled: false, loginOtpChannel: 'email' },
    });
    expect(disabled.newData.otpDeliveryChannel).toBe('whatsapp');
    ctx = await context(req);
    expect(email.present(ctx).enabled).toBe(false);
    const enabled = await admin.updateAccountOwnerEmailOtp({
        type: 'user',
        id: actor._id,
        payload: { email: 'customer@example.test', emailOtpEnabled: true, loginOtpChannel: 'email' },
    });
    expect(enabled.newData.otpDeliveryChannel).toBe('email');
    ctx = await context(req);
    expect(email.present(ctx).enabled).toBe(true);
});
