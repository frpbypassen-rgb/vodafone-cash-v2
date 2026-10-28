'use strict';
jest.mock('../services/telegramLoginTransport', () => ({
    configured: jest.fn(() => true),
    config: jest.fn(() => ({ botId: '900001', username: 'Ahram_otp_bot', ready: true })),
    sendCode: jest.fn().mockResolvedValue({ message_id: 1 }),
}));
jest.mock('../services/emailLoginEnrollmentMailer', () => ({
    configured: jest.fn(() => true),
    sendCode: jest.fn().mockResolvedValue(),
}));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User'),
    CompanyEmployee = require('../models/ClientEmployee'),
    Staff = require('../models/AgentEmployee');
const service = require('../services/telegramLoginSecurityService');
const transport = require('../services/telegramLoginTransport');
const mailer = require('../services/emailLoginEnrollmentMailer');
const login = require('../services/loginOtpService');
const invalidate = require('../utils/invalidateEmailLoginEnrollment');
const express = require('express'),
    request = require('supertest');
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
    await Promise.all([User.deleteMany({}), CompanyEmployee.deleteMany({}), Staff.deleteMany({})]);
    jest.clearAllMocks();
    transport.configured.mockReturnValue(true);
    transport.sendCode.mockResolvedValue({ message_id: 1 });
    mailer.configured.mockReturnValue(true);
    mailer.sendCode.mockResolvedValue();
    const actor = await User.create({
        name: 'وكالة تجربة',
        role: 'agent',
        webUsername: 'test-otp',
        webPassword: 'test-only-password',
        businessProfile: { email: 'owner@example.test' },
    });
    ctx = { actor, Model: User, sessionId: 'session-a', kind: 'agent', password: 'test-only-password' };
});
const reload = async () => {
    ctx.actor = await ctx.Model.findById(ctx.actor._id).select(
        '+telegramOtpEnrollment +emailOtpEnrollment +loginChannelAction +telegramLoginChatId +telegramLoginUserId'
    );
};
const begin = async () => {
    const result = await service.start(ctx);
    await reload();
    return new URL(result.url).searchParams.get('start');
};
const receive = (token) =>
    service.handleStart({ token, chatId: '112233', userId: '112233', username: 'demo_user' });
const link = async () => {
    const token = await begin();
    await receive(token);
    const code = transport.sendCode.mock.calls.at(-1)[1];
    await reload();
    await service.confirm({ ...ctx, code });
    await reload();
    return code;
};
test('password precedes link generation and configured bot is required', async () => {
    await expect(service.start({ ...ctx, password: 'wrong' })).rejects.toMatchObject({ code: 'PASSWORD' });
    transport.configured.mockReturnValue(false);
    await expect(service.start(ctx)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(transport.sendCode).not.toHaveBeenCalled();
});
test('deep link is opaque, bounded, single-use and cannot activate a login until website confirmation', async () => {
    const token = await begin();
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).not.toContain(String(ctx.actor._id));
    expect(JSON.stringify(service.present(ctx))).not.toContain(token);
    expect(await receive(token)).toBe(true);
    expect(await receive(token)).toBe(false);
    expect(transport.sendCode).toHaveBeenCalledTimes(1);
    const code = transport.sendCode.mock.calls[0][1];
    await reload();
    expect(ctx.actor.telegramLoginVerifiedAt).toBeNull();
    expect(ctx.actor.otpDeliveryChannel).toBe('whatsapp');
    await expect(service.confirm({ ...ctx, code: 'invalid' })).rejects.toMatchObject({ code: 'CODE' });
    await service.confirm({ ...ctx, code });
    await reload();
    expect(ctx.actor.telegramLoginChatId).toBe('112233');
    expect(ctx.actor.otpDeliveryChannel).toBe('telegram');
    expect(ctx.actor.telegramLoginVerifiedAt).toBeInstanceOf(Date);
    expect(ctx.actor.telegramOtpEnrollment).toBeUndefined();
    expect(JSON.stringify(service.present(ctx))).not.toContain('112233');
    await expect(service.confirm({ ...ctx, code })).rejects.toMatchObject({ code: 'EXPIRED' });
});
test.each([
    ['company', CompanyEmployee],
    ['agent_staff', Staff],
])('links the individual %s actor only', async (kind, Model) => {
    ctx.actor = await Model.create({
        name: 'تجربة',
        webUsername: kind,
        webPassword: ctx.password,
        companyId: new mongoose.Types.ObjectId(),
        agentId: new mongoose.Types.ObjectId(),
        role: kind === 'company' ? 'owner' : 'employee',
    });
    ctx.Model = Model;
    await link();
    expect(ctx.actor.otpDeliveryChannel).toBe('telegram');
    expect(await User.countDocuments({ telegramLoginVerifiedAt: { $ne: null } })).toBe(0);
});
test('forged, group and forwarded-user links are rejected without sending a code', async () => {
    const token = await begin();
    expect(await receive(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(await service.handleStart({ token, chatId: '-1001', userId: '112233' })).toBe(false);
    expect(await service.handleStart({ token, chatId: '112233', userId: '7777' })).toBe(false);
    expect(transport.sendCode).not.toHaveBeenCalled();
});
test('link cooldown and concurrent bot updates cannot resend enrollment codes', async () => {
    const token = await begin();
    await expect(service.start(ctx)).rejects.toMatchObject({ code: 'COOLDOWN' });
    const results = await Promise.all([receive(token), receive(token), receive(token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(transport.sendCode).toHaveBeenCalledTimes(1);
});
test('an unconfirmed account receives no login codes', async () => {
    const token = await begin();
    await receive(token);
    await reload();
    const before = transport.sendCode.mock.calls.length;
    expect((await login.issueLoginOtp({ account: ctx.actor, accountType: 'user', session: {} })).status).toBe(
        'skip_no_email'
    );
    expect(transport.sendCode).toHaveBeenCalledTimes(before);
});
test('failed delivery, wrong session and exhausted attempts never enable the link', async () => {
    const token = await begin();
    transport.sendCode.mockRejectedValueOnce(new Error('secret transport error'));
    expect(await receive(token)).toBe(false);
    await reload();
    await expect(service.confirm({ ...ctx, code: '123456' })).rejects.toMatchObject({ code: 'EXPIRED' });
    await ctx.Model.updateOne({ _id: ctx.actor._id }, { $unset: { telegramOtpEnrollment: 1 } });
    await reload();
    const next = await begin();
    await receive(next);
    const code = transport.sendCode.mock.calls.at(-1)[1];
    await reload();
    await expect(service.confirm({ ...ctx, sessionId: 'session-b', code })).rejects.toMatchObject({
        code: 'EXPIRED',
    });
    for (let i = 0; i < 5; i++)
        await expect(
            service.confirm({ ...ctx, code: code === '000000' ? '111111' : '000000' })
        ).rejects.toMatchObject({ code: 'CODE' });
    await expect(service.confirm({ ...ctx, code })).rejects.toMatchObject({ code: 'ATTEMPTS' });
});
test('expiry, password change and admin change invalidate pending links', async () => {
    const token = await begin();
    await ctx.Model.updateOne(
        { _id: ctx.actor._id },
        { $set: { 'telegramOtpEnrollment.expiresAt': Date.now() - 1 } }
    );
    expect(await receive(token)).toBe(false);
    await ctx.Model.updateOne({ _id: ctx.actor._id }, { $unset: { telegramOtpEnrollment: 1 } });
    await reload();
    const next = await begin();
    ctx.actor.webPassword = 'changed-password';
    await ctx.actor.save();
    expect(await receive(next)).toBe(false);
    await reload();
    invalidate(ctx.actor);
    await ctx.actor.save();
    expect(await receive(next)).toBe(false);
});
test('linking Telegram preserves an active email channel; switching requires the old channel code', async () => {
    ctx.actor.otpDeliveryChannel = 'email';
    ctx.actor.emailOtpVerifiedAt = new Date();
    ctx.actor.emailOtpVerifiedEmail = 'owner@example.test';
    await ctx.actor.save();
    await link();
    expect(ctx.actor.otpDeliveryChannel).toBe('email');
    expect((await service.requestChannel({ ...ctx, target: 'telegram' })).requiresCode).toBe(true);
    expect(mailer.sendCode).toHaveBeenCalledWith(
        'owner@example.test',
        expect.stringMatching(/^\d{6}$/),
        expect.objectContaining({ purpose: 'channel' })
    );
    const code = mailer.sendCode.mock.calls.at(-1)[1];
    await reload();
    await expect(service.confirmChannel({ ...ctx, code: 'bad' })).rejects.toMatchObject({ code: 'CODE' });
    await service.confirmChannel({ ...ctx, code });
    await reload();
    expect(ctx.actor.otpDeliveryChannel).toBe('telegram');
    await expect(service.confirmChannel({ ...ctx, code })).rejects.toMatchObject({ code: 'EXPIRED' });
});
test('Telegram login codes are sent only to the confirmed current bot and fail closed on outage', async () => {
    await link();
    transport.sendCode.mockClear();
    const first = await login.issueLoginOtp({ account: ctx.actor, accountType: 'user', session: {} });
    const second = await login.issueLoginOtp({ account: ctx.actor, accountType: 'user', session: {} });
    expect(first.status).toBe('sent');
    expect(second.status).toBe('sent');
    expect(first.otpChallengeId).not.toBe(second.otpChallengeId);
    expect(transport.sendCode).toHaveBeenLastCalledWith('112233', expect.stringMatching(/^\d{6}$/));
    transport.sendCode.mockRejectedValue(new Error('unavailable'));
    const previous = process.env.EMERGENCY_CLIENT_OTP_BYPASS;
    const expiry = process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT;
    process.env.EMERGENCY_CLIENT_OTP_BYPASS = 'true';
    process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT = new Date(Date.now() + 600000).toISOString();
    try {
        expect(
            (await login.issueLoginOtp({ account: ctx.actor, accountType: 'user', session: {} })).status
        ).toBe('failed');
    } finally {
        if (previous === undefined) delete process.env.EMERGENCY_CLIENT_OTP_BYPASS;
        else process.env.EMERGENCY_CLIENT_OTP_BYPASS = previous;
        if (expiry === undefined) delete process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT;
        else process.env.EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT = expiry;
    }
});
test('unverified or unconfigured channel choices and removing the selected link are blocked', async () => {
    await expect(service.requestChannel({ ...ctx, target: 'telegram' })).rejects.toMatchObject({
        code: 'TARGET_NOT_READY',
    });
    await link();
    await expect(service.requestChannel({ ...ctx, target: 'unlink' })).rejects.toMatchObject({
        code: 'TARGET_NOT_READY',
    });
    transport.configured.mockReturnValue(false);
    await expect(service.requestChannel({ ...ctx, target: 'email' })).rejects.toMatchObject({
        code: 'TARGET_NOT_READY',
    });
});
test('an enrollment code gets five minutes even when the deep link is opened just before expiry', async () => {
    const token = await begin();
    await ctx.Model.updateOne(
        { _id: ctx.actor._id },
        { $set: { 'telegramOtpEnrollment.expiresAt': Date.now() + 2000 } }
    );
    expect(await receive(token)).toBe(true);
    await reload();
    expect(ctx.actor.telegramOtpEnrollment.expiresAt).toBeGreaterThan(Date.now() + 290000);
});
test('email verification preserves Telegram selection, and switching back and unlinking require their own current-channel codes', async () => {
    await link();
    const emailService = require('../services/emailLoginEnrollmentService');
    const emailCtx = () => ({ ...ctx, isOwner: true, profileEmail: 'owner@example.test' });
    await emailService.start(emailCtx());
    const emailCode = mailer.sendCode.mock.calls.at(-1)[1];
    await reload();
    expect((await emailService.confirm({ ...emailCtx(), code: emailCode })).enabled).toBe(false);
    await reload();
    expect(ctx.actor.otpDeliveryChannel).toBe('telegram');
    await service.requestChannel({ ...ctx, target: 'email' });
    const telegramCode = transport.sendCode.mock.calls.at(-1)[1];
    await reload();
    await service.confirmChannel({ ...ctx, code: telegramCode });
    await reload();
    expect(ctx.actor.otpDeliveryChannel).toBe('email');
    await service.requestChannel({ ...ctx, target: 'unlink' });
    const removeCode = mailer.sendCode.mock.calls.at(-1)[1];
    await reload();
    await service.confirmChannel({ ...ctx, code: removeCode });
    await reload();
    expect(ctx.actor.telegramLoginVerifiedAt).toBeNull();
    expect(ctx.actor.otpDeliveryChannel).toBe('email');
});
test.each(['agent', 'company'])(
    '%s HTTP flow enforces authentication/CSRF and resolves the actor itself',
    async (kind) => {
        const oldTenantMode = process.env.TENANT_MODE;
        process.env.TENANT_MODE = 'single';
        try {
            if (kind === 'company') {
                const company = await require('../models/ClientCompany').create({
                    name: 'شركة اختبار',
                    status: 'active',
                });
                ctx.Model = CompanyEmployee;
                ctx.actor = await CompanyEmployee.create({
                    name: 'مالك اختبار',
                    role: 'owner',
                    companyId: company._id,
                    webUsername: 'http-owner',
                    webPassword: ctx.password,
                });
            }
            const prefix = kind === 'company' ? '/client' : '/agent-portal';
            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.sessionID = 'http-test-session';
                req.session = req.headers['x-test-anonymous']
                    ? {}
                    : {
                          isClientLoggedIn: true,
                          clientId: ctx.actor._id,
                          accountType: kind === 'company' ? 'company' : 'user',
                          clientSessionVersion: 0,
                          csrfToken: 'test-telegram-csrf',
                      };
                next();
            });
            app.use(require('../middlewares/csrfProtection'));
            app.use(prefix, require('../routes/portal/telegram-login'));
            const url = prefix + '/api/security/telegram-login';
            await request(app).get(url).set('x-test-anonymous', 'yes').expect(401);
            await request(app)
                .post(url + '/start')
                .send({ password: ctx.password })
                .expect(403);
            const start = await request(app)
                .post(url + '/start')
                .set('x-csrf-token', 'test-telegram-csrf')
                .send({ password: ctx.password, actorId: 'forged-owner', chatId: 'other' })
                .expect(200);
            await receive(new URL(start.body.url).searchParams.get('start'));
            const code = transport.sendCode.mock.calls.at(-1)[1];
            await request(app)
                .post(url + '/confirm')
                .set('x-csrf-token', 'test-telegram-csrf')
                .send({ code })
                .expect(200);
            const state = await request(app).get(url).expect(200);
            expect(state.body).toMatchObject({ selected: 'telegram', linked: true });
            expect(state.headers['cache-control']).toContain('no-store');
            expect(JSON.stringify(state.body)).not.toContain('112233');
        } finally {
            if (oldTenantMode === undefined) delete process.env.TENANT_MODE;
            else process.env.TENANT_MODE = oldTenantMode;
        }
    }
);
