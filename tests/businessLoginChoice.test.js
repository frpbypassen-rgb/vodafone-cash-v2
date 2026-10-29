'use strict';
jest.mock('../services/emailOtpMailer', () => ({
    getSmtpConfig: jest.fn(() => ({})),
    getMissingSmtpSettings: jest.fn(() => []),
    sendLoginOtpEmail: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../services/telegramLoginTransport', () => ({
    configured: jest.fn(() => true),
    config: jest.fn(() => ({ botId: '900001', username: 'Ahram_otp_bot' })),
    sendCode: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/securityControlService', () => ({
    authorizeLogin: jest.fn().mockResolvedValue({ allowed: true }),
    applySessionSecurity: jest.fn().mockResolvedValue(),
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue() }));
jest.mock('../utils/otp', () => ({ ...jest.requireActual('../utils/otp'), generateOtp: jest.fn() }));
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express'),
    request = require('supertest');
const User = require('../models/User'),
    Employee = require('../models/ClientEmployee'),
    Staff = require('../models/AgentEmployee'),
    Company = require('../models/ClientCompany');
const Challenge = require('../models/BusinessLoginChallenge');
const service = require('../services/businessLoginChoiceService');
const email = require('../services/emailOtpMailer'),
    telegram = require('../services/telegramLoginTransport');
const proof = require('../utils/emailLoginMfaProof'),
    otp = require('../utils/otp');
const security = require('../services/securityControlService');
const approval = require('../utils/loginMethodApproval');
let mongo, actor, req, oldTenant;
jest.setTimeout(120000);
const sessionRequest = () => {
    const value = { sessionID: 'before-login', body: {}, get: () => 'test browser' };
    const regenerate = (callback) => {
        value.sessionID = crypto.randomUUID();
        value.session = { regenerate, save: (callback) => callback() };
        callback();
    };
    value.session = { regenerate, save: (callback) => callback(), csrfToken: 'test-csrf' };
    return value;
};
beforeAll(async () => {
    oldTenant = process.env.TENANT_MODE;
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
});
beforeEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        Employee.deleteMany({}),
        Staff.deleteMany({}),
        Company.deleteMany({}),
        Challenge.deleteMany({}),
    ]);
    jest.clearAllMocks();
    email.getMissingSmtpSettings.mockReturnValue([]);
    email.sendLoginOtpEmail.mockResolvedValue({ success: true });
    telegram.configured.mockReturnValue(true);
    telegram.sendCode.mockResolvedValue({});
    otp.generateOtp.mockReset().mockReturnValueOnce('123456').mockReturnValue('654321');
    actor = await User.create({
        name: 'وكالة اختبار',
        webUsername: 'otp-choice-test',
        webPassword: 'test-password',
        role: 'agent',
        otpDeliveryChannel: 'email',
        emailOtpVerifiedAt: new Date(),
        emailOtpVerifiedEmail: 'owner@example.test',
        telegramLoginVerifiedAt: new Date(),
        telegramLoginChatId: '112233',
        telegramLoginBotId: '900001',
        telegramLoginUsername: 'demo_user',
    });
    req = sessionRequest();
    actor.telegramLoginApprovedFor = approval.telegramIdentity(actor);
    actor.emailOtpLoginApprovedFor = 'owner@example.test';
    await actor.save();
    await service.start(req, actor, 'user', { pendingSecurityUsername: actor.webUsername });
});
const allowResend = async (Model = User, id = actor._id) =>
    Model.updateOne({ _id: id }, { $set: { loginOtpLastSentAt: new Date(Date.now() - 61000) } });
test('password completion creates only a private pre-authentication challenge, with no delivery', async () => {
    const screen = await service.view(req);
    expect(screen.methods.map((x) => x.key)).toEqual(['email', 'telegram']);
    expect(screen.stage).toBe('choose');
    expect(req.session.isClientLoggedIn).not.toBe(true);
    expect(email.sendLoginOtpEmail).not.toHaveBeenCalled();
    expect(telegram.sendCode).not.toHaveBeenCalled();
    expect(JSON.stringify(screen)).not.toContain('owner@example.test');
    expect(JSON.stringify(screen)).not.toContain('112233');
    expect((await Challenge.findById(req.session.businessOtpChallengeId).lean()).binding).toBeUndefined();
});
test('only the selected channel receives a code and the saved preference is unchanged', async () => {
    const screen = await service.send(req, 'telegram');
    expect(screen).toMatchObject({ selected: 'telegram', stage: 'sent' });
    expect(telegram.sendCode).toHaveBeenCalledWith('112233', '123456', 'login', 5);
    expect(email.sendLoginOtpEmail).not.toHaveBeenCalled();
    expect((await User.findById(actor._id)).otpDeliveryChannel).toBe('email');
    expect((await service.consume(req, '123456')).accountType).toBe('user');
    await expect(service.consume(req, '123456')).rejects.toMatchObject({ statusCode: 401 });
});
test('changing delivery cancels the old code; cooldown spans both channels', async () => {
    await service.send(req, 'email');
    await service.change(req);
    await expect(service.consume(req, '123456')).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    await expect(service.send(req, 'telegram')).rejects.toMatchObject({ code: 'COOLDOWN' });
    await allowResend();
    await service.send(req, 'telegram');
    await expect(service.consume(req, '123456')).rejects.toMatchObject({ code: 'CODE_INVALID' });
    await expect(service.consume(req, '654321')).resolves.toMatchObject({ accountType: 'user' });
});
test('resending invalidates the previous code without changing the account settings', async () => {
    await service.send(req, 'email');
    await allowResend();
    await service.send(req, 'email');
    await expect(service.consume(req, '123456')).rejects.toMatchObject({ code: 'CODE_INVALID' });
    await service.consume(req, '654321');
    expect((await User.findById(actor._id)).otpDeliveryChannel).toBe('email');
});
test.each(['authenticator', 'whatsapp', 'unknown'])(
    'rejects forged method %s without delivery',
    async (method) => {
        await expect(service.send(req, method)).rejects.toMatchObject({ code: 'METHOD_UNAVAILABLE' });
        expect(email.sendLoginOtpEmail).not.toHaveBeenCalled();
        expect(telegram.sendCode).not.toHaveBeenCalled();
    }
);
test('unconfirmed Telegram and email are not offered as alternatives', async () => {
    await User.updateOne(
        { _id: actor._id },
        { $set: { emailOtpVerifiedAt: null, otpDeliveryChannel: 'telegram', telegramLoginVerifiedAt: null } }
    );
    const other = sessionRequest();
    const fresh = await User.findById(actor._id);
    await service.start(other, fresh, 'user', {});
    expect((await service.view(other)).methods).toHaveLength(0);
    await expect(service.send(other, 'telegram')).rejects.toMatchObject({ code: 'METHOD_UNAVAILABLE' });
});
test('a linked but unapproved alternative cannot bypass the existing login channel', async () => {
    await User.updateOne({ _id: actor._id }, { $unset: { telegramLoginApprovedFor: 1 } });
    const pending = sessionRequest();
    const fresh = await User.findById(actor._id);
    await service.start(pending, fresh, 'user', {});
    expect((await service.view(pending)).methods.map((method) => method.key)).toEqual(['email']);
    await expect(service.send(pending, 'telegram')).rejects.toMatchObject({ code: 'METHOD_UNAVAILABLE' });
});
test('delivery failure does not fall back or leave a usable code', async () => {
    email.sendLoginOtpEmail.mockResolvedValue({ success: false });
    await expect(service.send(req, 'email')).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
    expect(telegram.sendCode).not.toHaveBeenCalled();
    expect((await service.view(req)).stage).toBe('choose');
    await expect(service.consume(req, '123456')).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
});
test('concurrent sends produce one delivery, and concurrent verification consumes once', async () => {
    const sends = await Promise.allSettled([service.send(req, 'email'), service.send(req, 'telegram')]);
    expect(sends.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const attempts = await Promise.allSettled([
        service.consume(req, '123456'),
        service.consume(req, '123456'),
    ]);
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
});
test('a late provider reply cannot restore a code canceled during delivery', async () => {
    let sent, finish;
    const started = new Promise((resolve) => {
        sent = resolve;
    });
    email.sendLoginOtpEmail.mockImplementationOnce(() => {
        sent();
        return new Promise((resolve) => {
            finish = resolve;
        });
    });
    const sending = service.send(req, 'email');
    await started;
    await service.change(req);
    finish({ success: true });
    await expect(sending).rejects.toMatchObject({ code: 'CHANGED' });
    expect((await service.view(req)).stage).toBe('choose');
    await expect(service.consume(req, '123456')).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
});
test('browser binding, expiry, changed credentials and administrator changes block the attempt', async () => {
    await expect(service.view({ ...req, sessionID: 'stolen-session' })).rejects.toMatchObject({
        statusCode: 401,
    });
    await service.send(req, 'email');
    await User.updateOne({ _id: actor._id }, { $inc: { emailOtpSettingsRevision: 1 } });
    await expect(service.consume(req, '123456')).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    await Challenge.updateOne(
        { _id: req.session.businessOtpChallengeId },
        { $set: { expiresAt: new Date(Date.now() - 1) } }
    );
    await expect(service.view(req)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
});
test('five wrong codes lock the attempt', async () => {
    await service.send(req, 'email');
    for (let i = 0; i < 5; i++)
        await expect(service.consume(req, '000000')).rejects.toMatchObject({ code: 'CODE_INVALID' });
    await expect(service.consume(req, '123456')).rejects.toMatchObject({ statusCode: 401 });
});
test.each(['company', 'agent_staff'])(
    '%s has its own destination and retains mandatory Authenticator',
    async (type) => {
        let Model, parent;
        if (type === 'company') {
            Model = Employee;
            parent = await Company.create({ name: 'شركة', status: 'active' });
        } else {
            Model = Staff;
            parent = actor;
        }
        const staff = await Model.create({
            name: 'مالك أو موظف',
            webUsername: type,
            webPassword: 'test-password',
            companyId: type === 'company' ? parent._id : undefined,
            agentId: type === 'agent_staff' ? parent._id : undefined,
            role: type === 'company' ? 'owner' : 'employee',
            otpDeliveryChannel: 'email',
            email: 'staff@example.test',
            emailOtpVerifiedEmail: 'staff@example.test',
            emailOtpVerifiedAt: new Date(),
            mfaEnabled: true,
            mfaType: 'totp',
            mfaConfiguredAt: new Date(),
        });
        const pending = sessionRequest();
        await expect(service.start(pending, staff, type, {})).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
        const tokenProof = proof.create(staff, type);
        await service.start(pending, staff, type, { pendingEmailMfaProof: tokenProof });
        expect((await service.view(pending)).authenticatorVerified).toBe(true);
        await service.send(pending, 'email');
        expect(email.sendLoginOtpEmail).toHaveBeenLastCalledWith(
            expect.objectContaining({ to: 'staff@example.test' })
        );
        delete pending.session.pendingEmailMfaProof;
        await expect(service.consume(pending, '123456')).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    }
);
test('successful business OTP uses the existing final session and security gates', async () => {
    await service.send(req, 'email');
    req.body.otp = '123456';
    const res = { redirect: jest.fn(), render: jest.fn(), status: jest.fn().mockReturnThis() };
    await require('../controllers/clientAuthController').postVerify(req, res);
    expect(req.session.isClientLoggedIn).toBe(true);
    expect(req.session.businessOtpChallengeId).toBeUndefined();
    expect(security.authorizeLogin).toHaveBeenCalledWith(expect.objectContaining({ verifiedLogin: true }));
    expect(res.redirect).toHaveBeenCalled();
});
test('HTTP send/change endpoints require a bound attempt and CSRF; no arbitrary account is accepted', async () => {
    const app = express();
    app.use(express.json());
    req.session.csrfToken = 'choice-csrf';
    app.use((incoming, _res, next) => {
        incoming.session = incoming.headers['x-anonymous'] ? {} : req.session;
        incoming.sessionID = req.sessionID;
        next();
    });
    app.use(require('../middlewares/csrfProtection'));
    app.use('/client/verify', require('../routes/businessLoginChoice'));
    await request(app).post('/client/verify/send').send({ channel: 'email' }).expect(403);
    await request(app)
        .post('/client/verify/send')
        .set('x-csrf-token', 'choice-csrf')
        .send({ channel: 'email', accountId: 'other-actor', email: 'attacker@example.test' })
        .expect(200);
    expect(email.sendLoginOtpEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'owner@example.test' })
    );
    await request(app).post('/client/verify/change').set('x-csrf-token', 'choice-csrf').send({}).expect(200);
});
