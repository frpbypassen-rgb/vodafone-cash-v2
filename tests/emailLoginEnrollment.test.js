'use strict';
jest.mock('../services/emailLoginEnrollmentMailer', () => ({
    configured: jest.fn(() => true),
    sendCode: jest.fn().mockResolvedValue(),
}));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User');
const Employee = require('../models/ClientEmployee');
const Staff = require('../models/AgentEmployee');
const service = require('../services/emailLoginEnrollmentService');
const mailer = require('../services/emailLoginEnrollmentMailer');
const invalidate = require('../utils/invalidateEmailLoginEnrollment');
const { resolveAccountOtpEmail } = require('../utils/otpDeliveryChannel');
const { enrollmentEmail } = require('../services/reportEmailTemplate');
const express = require('express');
const request = require('supertest');
let mongo, ctx;
jest.setTimeout(120000);
beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});
beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Employee.deleteMany({}), Staff.deleteMany({})]);
    jest.clearAllMocks();
    mailer.configured.mockReturnValue(true);
    mailer.sendCode.mockResolvedValue();
    delete process.env.EMAIL_OTP_ENABLED;
    const actor = await User.create({
        name: 'وكالة تجريبية',
        webUsername: 'enrollment-test',
        webPassword: 'test-only-password',
        role: 'agent',
        businessProfile: { email: 'owner@example.test' },
    });
    ctx = {
        actor,
        Model: User,
        sessionId: 'session-a',
        kind: 'agent',
        isOwner: true,
        profileEmail: actor.businessProfile.email,
        password: 'test-only-password',
    };
});
const reload = async () => {
    ctx.actor = await ctx.Model.findById(ctx.actor._id).select('+emailOtpEnrollment');
    return ctx;
};
const issue = async () => {
    await service.start(ctx);
    const code = mailer.sendCode.mock.calls.at(-1)[1];
    await reload();
    return code;
};
test('password is required before any email, and a valid code is required before enabling', async () => {
    await expect(service.start({ ...ctx, password: 'wrong' })).rejects.toMatchObject({ code: 'PASSWORD' });
    expect(mailer.sendCode).not.toHaveBeenCalled();
    const code = await issue();
    expect(ctx.actor.otpDeliveryChannel).toBe('whatsapp');
    expect(ctx.actor.emailOtpEnrollment.hash).not.toContain(code);
    await expect(service.confirm({ ...ctx, code: 'invalid' })).rejects.toMatchObject({ code: 'CODE' });
    await service.confirm({ ...ctx, code });
    await reload();
    expect(ctx.actor.otpDeliveryChannel).toBe('email');
    expect(resolveAccountOtpEmail(ctx.actor)).toBe('owner@example.test');
    expect(ctx.actor.emailOtpEnrollment).toBeUndefined();
    expect(ctx.actor.emailOtpVerifiedAt).toBeInstanceOf(Date);
    await expect(service.confirm({ ...ctx, code })).rejects.toMatchObject({ code: 'EXPIRED' });
});
test.each(['company', 'agent_staff'])('enables the canonical login actor for %s', async (kind) => {
    const Model = kind === 'company' ? Employee : Staff;
    const actor = await Model.create({
        name: 'موظف تجريبي',
        webUsername: kind,
        webPassword: 'test-only-password',
        companyId: new mongoose.Types.ObjectId(),
        agentId: new mongoose.Types.ObjectId(),
        role: kind === 'company' ? 'owner' : 'employee',
        email: 'staff@example.test',
    });
    ctx = {
        ...ctx,
        Model,
        actor,
        kind: kind === 'company' ? 'company' : 'agent',
        isOwner: kind === 'company',
        profileEmail: 'company@example.test',
    };
    const code = await issue();
    await service.confirm({ ...ctx, code });
    await reload();
    expect(ctx.actor.otpDeliveryChannel).toBe('email');
    expect(resolveAccountOtpEmail(ctx.actor)).toBe(
        kind === 'company' ? 'company@example.test' : 'staff@example.test'
    );
});
test('missing profile email cannot fall back to an unrelated owner email', async () => {
    await expect(service.start({ ...ctx, profileEmail: '' })).rejects.toMatchObject({
        code: 'PROFILE_EMAIL_REQUIRED',
    });
    expect(mailer.sendCode).not.toHaveBeenCalled();
});
test('SMTP disabled or failed never enables protection', async () => {
    mailer.configured.mockReturnValue(false);
    await expect(service.start(ctx)).rejects.toMatchObject({ code: 'SMTP_UNAVAILABLE' });
    mailer.configured.mockReturnValue(true);
    mailer.sendCode.mockRejectedValue(new Error('smtp-secret-error'));
    await expect(service.start(ctx)).rejects.toMatchObject({ code: 'EMAIL_SEND_FAILED' });
    await reload();
    await expect(service.confirm({ ...ctx, code: '000000' })).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(ctx.actor.otpDeliveryChannel).toBe('whatsapp');
});
test('concurrent sends reserve only one challenge and enforce cooldown', async () => {
    const results = await Promise.allSettled([service.start(ctx), service.start(ctx), service.start(ctx)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(mailer.sendCode).toHaveBeenCalledTimes(1);
});
test('new code invalidates old code', async () => {
    const old = await issue();
    await User.updateOne(
        { _id: ctx.actor._id },
        { $set: { 'emailOtpEnrollment.issuedAt': Date.now() - 61000 } }
    );
    await reload();
    const code = await issue();
    if (code !== old)
        await expect(service.confirm({ ...ctx, code: old })).rejects.toMatchObject({ code: 'CODE' });
    await service.confirm({ ...ctx, code });
});
test('five failed attempts lock the challenge across sessions and reloads', async () => {
    const code = await issue();
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++)
        await expect(service.confirm({ ...ctx, code: wrong })).rejects.toMatchObject({ code: 'CODE' });
    await expect(service.confirm({ ...ctx, code })).rejects.toMatchObject({ code: 'ATTEMPTS' });
});
test('expiry, changed profile, another session and changed password reject confirmation', async () => {
    const code = await issue();
    await expect(service.confirm({ ...ctx, sessionId: 'session-b', code })).rejects.toMatchObject({
        code: 'EXPIRED',
    });
    await expect(
        service.confirm({ ...ctx, profileEmail: 'changed@example.test', code })
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    await User.updateOne(
        { _id: ctx.actor._id },
        { $set: { 'emailOtpEnrollment.expiresAt': Date.now() - 1 } }
    );
    await reload();
    await expect(service.confirm({ ...ctx, code })).rejects.toMatchObject({ code: 'EXPIRED' });
});
test('admin changes invalidate pending codes and verified address while preserving canonical channel', async () => {
    const code = await issue();
    const stale = ctx.actor;
    const adminActor = await User.findById(ctx.actor._id);
    invalidate(adminActor);
    await adminActor.save();
    await expect(service.confirm({ ...ctx, actor: stale, code })).rejects.toMatchObject({ code: 'ATTEMPTS' });
    await reload();
    expect(ctx.actor.emailOtpVerifiedAt).toBeNull();
});
test('concurrent confirmations cannot consume the same activation twice', async () => {
    const code = await issue();
    const results = await Promise.allSettled([
        service.confirm({ ...ctx, code }),
        service.confirm({ ...ctx, code }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
});
test('profile changes do not silently redirect the verified login factor', async () => {
    const code = await issue();
    await service.confirm({ ...ctx, code });
    await User.updateOne({ _id: ctx.actor._id }, { $set: { 'businessProfile.email': 'new@example.test' } });
    await reload();
    expect(resolveAccountOtpEmail(ctx.actor)).toBe('owner@example.test');
    expect(service.present({ ...ctx, profileEmail: 'new@example.test' }).canChangeEmail).toBe(true);
    expect((await User.findById(ctx.actor._id).lean()).emailOtpEnrollment).toBeUndefined();
});
test('activation email uses the unified shell with purpose-specific copy and no report claims', () => {
    const email = enrollmentEmail({ code: '123456', kind: 'company', accountName: '<script>bad</script>' });
    expect(email.html).toContain('فعّل حماية الدخول بالبريد');
    expect(email.html).toContain('5 دقائق');
    expect(email.html).not.toContain('استلام كشف الحساب اليومي');
    expect(email.html).not.toContain('<script>bad');
    expect(email.attachments[0].cid).toBe('ahram-report-logo');
});
test('shared HTTP routes enforce authentication and CSRF and ignore caller-supplied actor/email', async () => {
    const oldTenantMode = process.env.TENANT_MODE;
    process.env.TENANT_MODE = 'single';
    try {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.sessionID = 'http-test-session';
            req.session = req.headers['x-test-anonymous']
                ? {}
                : {
                      isClientLoggedIn: true,
                      clientId: ctx.actor._id,
                      accountType: 'user',
                      clientSessionVersion: 0,
                      csrfToken: 'http-test-csrf',
                  };
            next();
        });
        app.use(require('../middlewares/csrfProtection'));
        app.use('/agent-portal', require('../routes/portal/email-login'));
        await request(app)
            .get('/agent-portal/api/security/email-login')
            .set('x-test-anonymous', 'yes')
            .expect(401);
        await request(app)
            .post('/agent-portal/api/security/email-login/start')
            .send({ password: ctx.password })
            .expect(403);
        const sent = await request(app)
            .post('/agent-portal/api/security/email-login/start')
            .set('x-csrf-token', 'http-test-csrf')
            .send({ password: ctx.password, actorId: 'other', email: 'attacker@example.test' })
            .expect(200);
        expect(sent.body.success).toBe(true);
        expect(mailer.sendCode.mock.calls.at(-1)[0]).toBe('owner@example.test');
        const code = mailer.sendCode.mock.calls.at(-1)[1];
        await request(app)
            .post('/agent-portal/api/security/email-login/confirm')
            .set('x-csrf-token', 'http-test-csrf')
            .send({ code })
            .expect(200);
        const state = await request(app).get('/agent-portal/api/security/email-login').expect(200);
        expect(state.body).toMatchObject({ enabled: true, verified: true });
        expect(JSON.stringify(state.body)).not.toContain(code);
        expect(state.headers['cache-control']).toContain('no-store');
    } finally {
        if (oldTenantMode === undefined) delete process.env.TENANT_MODE;
        else process.env.TENANT_MODE = oldTenantMode;
    }
});
