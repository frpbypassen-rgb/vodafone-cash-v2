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
let mongo, parent, oldTenant;
jest.setTimeout(120000);
beforeAll(async () => {
    oldTenant = process.env.TENANT_MODE;
    process.env.TENANT_MODE = 'single';
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongo.getUri());
    await Challenge.init();
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    if (oldTenant === undefined) delete process.env.TENANT_MODE;
    else process.env.TENANT_MODE = oldTenant;
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
