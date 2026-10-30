'use strict';
jest.mock('../services/customerReportEmailMailer', () => ({
    configured: jest.fn(() => true),
    sendCode: jest.fn().mockResolvedValue(),
    sendStatement: jest.fn().mockResolvedValue(),
}));
jest.mock('../services/telegramService', () => ({
    ...jest.requireActual('../services/telegramService'),
    telegramConfigured: jest.fn(() => true),
    getBotUsername: jest.fn().mockResolvedValue('Ahrampay_bot'),
    sendMessage: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../services/rateAlerts/webPushService', () => ({
    isConfigured: jest.fn(() => true),
    getConfiguration: jest.fn(() => ({
        publicKey: 'test',
        privateKey: 'test',
        subject: 'mailto:test@example.test',
    })),
}));
jest.mock('web-push', () => ({
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn().mockResolvedValue(),
}));
jest.mock('../services/customerDailyStatementService', () => ({
    previousDay: () => '2026-10-29',
    createStatementPdf: jest.fn().mockResolvedValue(Buffer.from('test-pdf')),
}));
const mongoose = require('mongoose'),
    { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/User'),
    Sub = require('../models/SubAccount'),
    Pref = require('../models/CustomerNotificationPreference'),
    Email = require('../models/CustomerReportEmail'),
    Link = require('../models/TelegramAccountLink'),
    Push = require('../models/WebPushSubscription'),
    Delivery = require('../models/CustomerReportEmailDelivery');
const service = require('../services/customerNotificationService'),
    email = require('../services/customerReportEmailService'),
    mailer = require('../services/customerReportEmailMailer'),
    telegram = require('../services/telegramService'),
    worker = require('../services/customerReportEmailWorker'),
    webpush = require('web-push');
let mongo, ctx, oldSecret, oldWebhook;
jest.setTimeout(120000);
beforeAll(async () => {
    oldSecret = process.env.SESSION_SECRET;
    oldWebhook = process.env.TELEGRAM_WEBHOOK_SECRET;
    process.env.SESSION_SECRET = 'test-notification-secret-with-more-than-32-characters';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-hook-secret';
    mongo = await MongoMemoryReplSet.create({
        binary: { version: '7.0.24' },
        replSet: { count: 1 },
        instanceOpts: [{ launchTimeout: 60000 }],
    });
    await mongoose.connect(mongo.getUri());
    await Promise.all([Pref.init(), Email.init(), Link.init(), Push.init(), Delivery.init()]);
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    if (oldSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = oldSecret;
    if (oldWebhook === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = oldWebhook;
});
beforeEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        Sub.deleteMany({}),
        Pref.deleteMany({}),
        Email.deleteMany({}),
        Link.deleteMany({}),
        Push.deleteMany({}),
        Delivery.deleteMany({}),
        require('../models/Transaction').deleteMany({}),
    ]);
    jest.clearAllMocks();
    mailer.sendStatement.mockResolvedValue();
    const actor = await User.create({
        name: 'عميل',
        role: 'user',
        webUsername: 'notification-customer',
        webPassword: 'test-password',
        phone: '0910000001',
    });
    ctx = { actor, entity: actor, actorModel: 'User', accountType: 'user', isCustomer: true };
});
const payload = (s) => ({
    revision: s.revision,
    emailRevision: s.email.revision,
    telegramRevision: s.telegram.revision,
    ratesEnabled: s.ratesEnabled,
    emailEnabled: s.email.enabled,
    telegramEnabled: s.telegram.enabled,
});
const verifyEmail = async () => {
    const initial = await email.getStatus(ctx);
    const pending = await email.requestCode(ctx, 'notify@example.test', new Date(), initial.revision);
    const code = mailer.sendCode.mock.calls.at(-1)[1];
    await email.verifyCode(ctx, pending.challengeId, code, new Date(), pending.revision);
};
test('defaults are read-only and saving requires verified destinations; no partial updates', async () => {
    const initial = await service.status(ctx);
    expect(initial.ratesEnabled).toBe(true);
    expect(initial.email.verified).toBe(false);
    expect(await Pref.countDocuments()).toBe(0);
    await expect(
        service.save(ctx, { ...payload(initial), ratesEnabled: false, emailEnabled: true })
    ).rejects.toMatchObject({ code: 'VERIFY_EMAIL' });
    expect((await service.status(ctx)).ratesEnabled).toBe(true);
    const saved = await service.save(ctx, { ...payload(initial), ratesEnabled: false });
    expect(saved.ratesEnabled).toBe(false);
    await expect(service.save(ctx, { ...payload(initial), ratesEnabled: true })).rejects.toMatchObject({
        code: 'SETTINGS_CHANGED',
    });
    expect((await service.status(ctx)).ratesEnabled).toBe(false);
});
test('email confirmation is one-use, cannot replace login email, and controls real test delivery', async () => {
    ctx.actor.emailOtpVerifiedAt = new Date();
    ctx.actor.emailOtpVerifiedEmail = 'login@example.test';
    await ctx.actor.save();
    await expect(worker.sendTest(ctx)).rejects.toMatchObject({ code: 'TEST_NOT_AVAILABLE' });
    await verifyEmail();
    expect((await service.status(ctx)).email.enabled).toBe(true);
    expect((await User.findById(ctx.actor._id)).emailOtpVerifiedEmail).toBe('login@example.test');
    const result = await worker.sendTest(ctx);
    expect(result.status).toBe('sent');
    expect(mailer.sendStatement).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'notify@example.test', test: true })
    );
    await expect(worker.sendTest(ctx)).rejects.toMatchObject({ code: 'TEST_NOT_AVAILABLE' });
    const state = await service.status(ctx);
    await service.save(ctx, { ...payload(state), emailEnabled: false });
    expect((await service.status(ctx)).email.enabled).toBe(false);
    await expect(worker.sendTest(ctx)).rejects.toMatchObject({ code: 'TEST_NOT_AVAILABLE' });
});
test('receipt bot link does not enable receipts until preferences are saved; admin state is canonical', async () => {
    const start = await service.requestTelegram(ctx, 0);
    const code = new URL(start.botUrl).searchParams.get('start');
    expect(start.botUrl).toContain('Ahrampay_bot');
    await expect(service.testTelegram(ctx)).rejects.toMatchObject({ code: 'NOT_ENABLED' });
    expect(
        (
            await telegram.linkChatByCode({
                code,
                chatId: '123456',
                telegramUser: { username: 'customer_chat', first_name: 'عميل' },
            })
        ).success
    ).toBe(true);
    expect((await telegram.linkChatByCode({ code, chatId: '123456' })).success).toBe(false);
    let state = await service.status(ctx);
    expect(state.telegram.linked).toBe(true);
    expect(state.telegram.enabled).toBe(false);
    state = await service.save(ctx, { ...payload(state), telegramEnabled: true });
    expect((await Link.findOne({ ownerId: ctx.actor._id })).deliveryMode).toBe('telegram');
    await service.testTelegram(ctx);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    await Link.updateOne(
        { ownerId: ctx.actor._id },
        { $set: { deliveryMode: 'off', active: false }, $inc: { settingsRevision: 1 } }
    );
    expect((await service.status(ctx)).telegram.enabled).toBe(false);
    await expect(service.save(ctx, { ...payload(state), ratesEnabled: false })).rejects.toMatchObject({
        code: 'SETTINGS_CHANGED',
    });
    expect((await service.status(ctx)).ratesEnabled).toBe(true);
});
test('push test is bound to this owner and endpoint, requires activation and is throttled', async () => {
    const subscription = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test-device',
        keys: { p256dh: 'test-key', auth: 'test-auth' },
    };
    await expect(service.testPush(ctx, subscription.endpoint)).rejects.toMatchObject({ code: 'NOT_ENABLED' });
    await service.subscribe(ctx, subscription);
    expect((await service.deviceStatus(ctx, subscription.endpoint)).active).toBe(true);
    await service.testPush(ctx, subscription.endpoint);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    await expect(service.testPush(ctx, subscription.endpoint)).rejects.toMatchObject({ code: 'COOLDOWN' });
    const foreign = { ...ctx, actor: { _id: new mongoose.Types.ObjectId() } };
    await expect(service.testPush(foreign, subscription.endpoint)).rejects.toMatchObject({
        code: 'NOT_ENABLED',
    });
    await service.disable(ctx, subscription.endpoint);
    expect((await service.deviceStatus(ctx, subscription.endpoint)).active).toBe(false);
    expect(() => service.endpoint('https://127.0.0.1/private')).toThrow();
    expect(() => service.endpoint('http://fcm.googleapis.com/test')).toThrow();
});
test('customer identities and tenants cannot read another subscriber or inherit an agency subscription', async () => {
    await verifyEmail();
    const foreignActor = await User.create({
        name: 'عميل',
        role: 'user',
        webUsername: 'foreign-notification',
        webPassword: 'test-password',
    });
    const other = {
        actor: foreignActor,
        entity: foreignActor,
        actorModel: 'User',
        accountType: 'user',
        isCustomer: true,
    };
    expect((await service.status(other)).email.email).toBe('');
    const tenant = {
        ...ctx,
        entity: { ...ctx.actor.toObject(), tenantId: new mongoose.Types.ObjectId() },
        actor: { ...ctx.actor.toObject(), tenantId: new mongoose.Types.ObjectId() },
    };
    expect((await service.status(tenant)).email.email).toBe('');
});

test('daily statement is strictly customer scoped, read-only and uses the sub-customer charge', async () => {
    const Transaction = require('../models/Transaction'),
        reporting = jest.requireActual('../services/customerDailyStatementService');
    const day = '2026-10-29',
        at = new Date('2026-10-29T10:00:00Z'),
        before = new Date('2026-10-28T10:00:00Z');
    await Transaction.collection.insertMany([
        {
            customId: 'own-opening',
            userId: ctx.actor.phone,
            status: 'deposit',
            amount: 1000,
            createdAt: before,
        },
        {
            customId: 'own-operation',
            userId: ctx.actor.phone,
            status: 'completed',
            amount: 100,
            costLYD: 10,
            createdAt: at,
        },
        {
            customId: 'same-name-foreign',
            userId: 'foreign',
            employeeName: ctx.actor.name,
            companyName: 'عميل فردي',
            status: 'completed',
            amount: 900,
            costLYD: 90,
            createdAt: at,
        },
        {
            customId: 'foreign-tenant',
            userId: ctx.actor.phone,
            tenantId: new mongoose.Types.ObjectId(),
            status: 'completed',
            amount: 900,
            costLYD: 90,
            createdAt: at,
        },
    ]);
    let report = await reporting.loadStatement(ctx, day);
    expect(report.stats.previousBalance).toBe(1000);
    expect(report.stats.endingBalance).toBe(990);
    expect(report.operations.map((row) => row.customId)).toEqual(['own-operation']);
    const sub = await Sub.create({
        name: 'عميل تابع',
        masterType: 'user',
        masterId: ctx.actor._id,
        webUsername: 'report-sub',
        webPassword: 'test-password',
    });
    const subctx = {
        actor: sub,
        entity: sub,
        actorModel: 'SubAccount',
        accountType: 'sub_client',
        isCustomer: true,
    };
    await Transaction.collection.insertMany([
        { customId: 'sub-open', subAccountId: sub._id, status: 'deposit', amount: 100, createdAt: before },
        {
            customId: 'sub-own',
            subAccountId: sub._id,
            status: 'completed',
            amount: 100,
            costLYD: 10,
            subAccountCostLYD: 30,
            agencyPricing: { customerChargeLYD: 35, agentCostLYD: 10, profitLYD: 25 },
            createdAt: at,
        },
    ]);
    report = await reporting.loadStatement(subctx, day);
    expect(report.stats.endingBalance).toBe(65);
    expect(report.operations[0].costLYD).toBe(35);
    expect(JSON.stringify(report)).not.toContain('profitLYD');
    expect(JSON.stringify(report)).not.toContain('agentCostLYD');
    expect(await Transaction.countDocuments()).toBe(6);const html=await require('ejs').renderFile(require('path').join(__dirname,'../views/reports_pdf.ejs'),{report,generatedAt:new Date(),adminName:'العميل',logoDataUri:''});expect(html).toContain('sub-own');
});
test('ambiguous SMTP delivery is not automatically sent twice', async () => {
    await verifyEmail();
    const subscription = await Email.findOne({ actorId: ctx.actor._id });
    const job = await worker.enqueue(subscription, '2026-10-29', 'daily');
    const duplicate = await worker.enqueue(subscription, '2026-10-29', 'daily');
    expect(String(duplicate._id)).toBe(String(job._id));
    mailer.sendStatement.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    expect((await worker.deliver(job._id)).status).toBe('uncertain');
    expect((await worker.deliver(job._id)).status).toBe('already_claimed');
    expect(mailer.sendStatement).toHaveBeenCalledTimes(1);
});
test('concurrent preference saves cannot overwrite each other', async () => {
    const current = await service.status(ctx);
    const results = await Promise.allSettled([
        service.save(ctx, { ...payload(current), ratesEnabled: false }),
        service.save(ctx, { ...payload(current), ratesEnabled: true }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((row) => row.status === 'rejected').reason.code).toBe('SETTINGS_CHANGED');
});
