'use strict';
jest.mock('../services/agentReportEmailMailer', () => ({ configured: jest.fn(() => true), sendCode: jest.fn(), sendStatement: jest.fn() }));
jest.mock('../services/settlementService', () => ({ ensureDailySettlements: jest.fn() }));
jest.mock('../services/agentDailyStatementService', () => ({ ...jest.requireActual('../services/agentDailyStatementService'), createStatementPdf: jest.fn(async () => Buffer.from('test-pdf')) }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Subscription = require('../models/AgentReportEmail');
const Delivery = require('../models/AgentReportEmailDelivery');
const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const SubAccount = require('../models/SubAccount');
const service = require('../services/agentReportEmailService');
const worker = require('../services/agentReportEmailWorker');
const statement = require('../services/agentDailyStatementService');
const mailer = require('../services/agentReportEmailMailer');
const { buildWorkspaceResult } = require('../services/portalWorkspace/factory');
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');
let mongo, workspace, now;
jest.setTimeout(120000);
beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-only-statement-email-secret-123456789';
    process.env.TENANT_MODE = 'multi';
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongo.getUri());
    await Promise.all([Subscription.init(), Delivery.init()]);
});
afterAll(async () => { worker.stop(); await mongoose.disconnect(); if (mongo) await mongo.stop(); });
beforeEach(async () => {
    jest.clearAllMocks();
    mailer.configured.mockReturnValue(true);
    mailer.sendCode.mockResolvedValue({ accepted: ['test@example.com'] });
    mailer.sendStatement.mockResolvedValue({ accepted: ['test@example.com'] });
    statement.createStatementPdf.mockResolvedValue(Buffer.from('test-pdf'));
    for (const Model of [Subscription, Delivery, User, AgentEmployee, Transaction, Ledger, SubAccount]) await Model.collection.deleteMany({});
    now = new Date();
    const actor = { _id: new mongoose.Types.ObjectId(), role: 'agent', status: 'active', name: 'وكالة اختبار', phone: '0911111111', tenantId: new mongoose.Types.ObjectId(), balance: 999999 };
    await User.collection.insertOne(actor);
    workspace = buildWorkspaceResult({ type: 'agent', actor, entity: actor, actorModel: 'User', entityModel: 'User', permissions: resolveAgentPermissions(actor) });
});
const verify = async () => {
    const response = await service.requestCode(workspace, 'verified@example.com', now);
    const code = mailer.sendCode.mock.calls.at(-1)[1];
    return service.verifyCode(workspace, response.challengeId, code, now);
};
test('subscription remains disabled until the emailed code is confirmed and no plaintext code is stored', async () => {
    const pending = await service.requestCode(workspace, 'Verified@Example.com', now);
    const code = mailer.sendCode.mock.calls[0][1];
    expect(code).toMatch(/^\d{6}$/);
    const stored = await Subscription.findOne().select('+challengeHash').lean();
    expect(stored.email).toBe('');
    expect(stored.enabled).toBe(false);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(pending).not.toHaveProperty('challengeHash');
    await expect(service.setEnabled(workspace, true)).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    const confirmed = await service.verifyCode(workspace, pending.challengeId, code, now);
    expect(confirmed).toMatchObject({ email: 'verified@example.com', enabled: true, verified: true });
    await expect(service.verifyCode(workspace, pending.challengeId, code, now)).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
});
test('parallel code requests permit one send and enforce a durable cooldown', async () => {
    const results = await Promise.allSettled([service.requestCode(workspace, 'one@example.com', now), service.requestCode(workspace, 'two@example.com', now)]);
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(mailer.sendCode).toHaveBeenCalledTimes(1);
    expect(await Subscription.countDocuments()).toBe(1);
});
test('five incorrect attempts invalidate even a correct code', async () => {
    const pending = await service.requestCode(workspace, 'one@example.com', now);
    const code = mailer.sendCode.mock.calls[0][1];
    const wrong = code === '000000' ? '111111' : '000000';
    for (let index = 0; index < 5; index++) await expect(service.verifyCode(workspace, pending.challengeId, wrong, now)).rejects.toMatchObject({ code: 'INVALID_CODE' });
    await expect(service.verifyCode(workspace, pending.challengeId, code, now)).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
});
test('expired codes and codes from another account cannot activate a subscription', async () => {
    const pending = await service.requestCode(workspace, 'one@example.com', now);
    const code = mailer.sendCode.mock.calls[0][1];
    const other = { ...workspace, actor: { ...workspace.actor, _id: new mongoose.Types.ObjectId() } };
    await expect(service.verifyCode(other, pending.challengeId, code, now)).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
    await expect(service.verifyCode(workspace, pending.challengeId, code, new Date(now.getTime() + 600001))).rejects.toMatchObject({ code: 'CODE_EXPIRED' });
});
test('changing the pending address does not replace the verified recipient until confirmed', async () => {
    await verify();
    const pending = await service.requestCode(workspace, 'replacement@example.com', new Date(now.getTime() + 61000));
    expect(pending.email).toBe('verified@example.com');
    expect(pending.pendingEmail).toBe('replacement@example.com');
    expect(pending.enabled).toBe(true);
});
test('SMTP failure cannot leave a usable code or activate an address', async () => {
    mailer.sendCode.mockRejectedValueOnce(new Error('SMTP failed'));
    await expect(service.requestCode(workspace, 'one@example.com', now)).rejects.toMatchObject({ code: 'EMAIL_SEND_FAILED' });
    const row = await Subscription.findOne().select('+challengeHash').lean();
    expect(row.challengeHash).toBeUndefined();
    expect(row.enabled).toBe(false);
});
test('scheduling uses Libya midnight and does not become due before 00:05', () => {
    expect(worker.dueDay(new Date('2026-10-25T22:04:59Z'))).toBeNull();
    expect(worker.dueDay(new Date('2026-10-25T22:05:00Z'))).toBe('2026-10-25');
    expect(worker.dueDay(new Date('2026-10-26T18:00:00Z'))).toBe('2026-10-25');
});
test('daily jobs are unique and concurrent workers send a job only once', async () => {
    await verify();
    const sub = await Subscription.findOne().lean();
    const jobs = await Promise.all([worker.enqueue(sub, '2026-10-25'), worker.enqueue(sub, '2026-10-25')]);
    expect(String(jobs[0]._id)).toBe(String(jobs[1]._id));
    await Promise.all([worker.deliver(jobs[0]._id), worker.deliver(jobs[0]._id)]);
    expect(mailer.sendStatement).toHaveBeenCalledTimes(1);
    expect((await Delivery.findById(jobs[0]._id)).status).toBe('sent');
});
test('unsubscribing prevents queued deliveries', async () => {
    await verify(); const sub = await Subscription.findOne().lean();
    const job = await worker.enqueue(sub, '2026-10-25');
    await service.setEnabled(workspace, false);
    expect(await worker.deliver(job._id)).toMatchObject({ status: 'cancelled' });
    expect(mailer.sendStatement).not.toHaveBeenCalled();
});
test('revocation during PDF rendering prevents delivery', async () => {
    await verify(); const sub = await Subscription.findOne().lean();
    const job = await worker.enqueue(sub, '2026-10-25');
    statement.createStatementPdf.mockImplementationOnce(async () => { await User.collection.updateOne({ _id: workspace.actor._id }, { $set: { status: 'suspended' } }); return Buffer.from('pdf'); });
    expect(await worker.deliver(job._id)).toMatchObject({ status: 'cancelled' });
    expect(mailer.sendStatement).not.toHaveBeenCalled();
});
test('tenant changes invalidate a previously verified subscription', async () => {
    await verify(); const sub = await Subscription.findOne().lean();
    const job = await worker.enqueue(sub, '2026-10-25');
    await User.collection.updateOne({ _id: workspace.actor._id }, { $set: { tenantId: new mongoose.Types.ObjectId() } });
    expect(await worker.deliver(job._id)).toMatchObject({ status: 'cancelled' });
    expect(mailer.sendStatement).not.toHaveBeenCalled();
});
test('ambiguous SMTP timeouts are not automatically resent', async () => {
    await verify(); const sub = await Subscription.findOne().lean();
    const job = await worker.enqueue(sub, '2026-10-25');
    mailer.sendStatement.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    expect(await worker.deliver(job._id)).toMatchObject({ status: 'uncertain' });
    await worker.deliver(job._id, new Date(now.getTime() + 3600000));
    expect(mailer.sendStatement).toHaveBeenCalledTimes(1);
});
test('email uses the comprehensive administration report for the same agency and Libya day without closing financial days', async () => {
    const common = { userId: workspace.entity.phone, tenantId: workspace.entity.tenantId, isSubAccountTx: false, companyId: null };
    await Transaction.collection.insertMany([
        { ...common, customId: 'OPEN', status: 'deposit', amount: 100, createdAt: new Date('2026-10-24T08:00:00Z') },
        { ...common, customId: 'D1', status: 'deposit', amount: 50, createdAt: new Date('2026-10-25T08:00:00Z') },
        { ...common, customId: 'T1', status: 'completed', amount: 150, costLYD: 30, createdAt: new Date('2026-10-25T10:00:00Z') },
        { ...common, customId: 'NEXT-DAY', status: 'deposit', amount: 999999, createdAt: new Date('2026-10-25T22:01:00Z') },
        { ...common, customId: 'OTHER-TENANT', tenantId: new mongoose.Types.ObjectId(), status: 'deposit', amount: 888888, createdAt: new Date('2026-10-25T08:00:00Z') },
    ]);
    const data = await statement.loadStatement(workspace, '2026-10-25');
    const { loadAdminReport } = require('../services/adminReportService');
    const expected = await loadAdminReport({ mainCategory: 'agent', subId: String(workspace.entity._id), subType: 'all', dateType: 'day', dateValue: '2026-10-25', tenantId: workspace.entity.tenantId }, { readOnly: true });
    expect(data).toEqual(expected);
    expect(data.stats).toMatchObject({ previousBalance: 100, endingBalance: 120, totalDeposits: 50, totalLYD: 30 });
    expect(require('../services/settlementService').ensureDailySettlements).not.toHaveBeenCalled();
});
test('employees without agency-wide account access cannot receive the comprehensive administration statement', async () => {
    const actor = { _id: new mongoose.Types.ObjectId(), role: 'employee', name: 'Employee', agentId: workspace.entity._id, tenantId: workspace.entity.tenantId };
    const ownWorkspace = { ...workspace, actor, actorModel: 'AgentEmployee', permissions: resolveAgentPermissions(actor) };
    await Transaction.collection.insertMany([
        { customId: 'OWN', userId: workspace.entity.phone, companyId: null, subAccountId: null, clientActorId: String(actor._id), tenantId: workspace.entity.tenantId, status: 'completed', amount: 100, transferType: 'vodafone', createdAt: new Date('2026-10-25T08:00:00Z') },
        { customId: 'OTHER', userId: workspace.entity.phone, companyId: null, subAccountId: null, clientActorId: 'other-actor', tenantId: workspace.entity.tenantId, status: 'completed', amount: 200, transferType: 'vodafone', createdAt: new Date('2026-10-25T08:00:00Z') },
        { customId: 'OTHER-TENANT', userId: workspace.entity.phone, companyId: null, subAccountId: null, clientActorId: String(actor._id), tenantId: new mongoose.Types.ObjectId(), status: 'completed', amount: 300, transferType: 'vodafone', createdAt: new Date('2026-10-25T08:00:00Z') },
    ]);
    expect(() => statement.loadStatement(ownWorkspace, '2026-10-25')).toThrow('REPORT_FORBIDDEN');
    await expect(service.requestCode(ownWorkspace, 'employee@example.com')).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
