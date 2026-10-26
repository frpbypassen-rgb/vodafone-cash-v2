'use strict';
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
jest.mock('../services/auditService', () => ({ logAction: jest.fn(async () => {}) }));
jest.mock('../services/companyReportEmailMailer', () => ({ configured: () => true, sendCode: jest.fn(async () => {}), sendStatement: jest.fn(async () => {}) }));
jest.mock('../services/telegramService', () => ({ telegramConfigured: () => true, getBotUsername: async () => 'Ahrampay_bot', sendMessage: jest.fn(async () => {}) }));
const Company = require('../models/ClientCompany');
const Staff = require('../models/ClientEmployee');
const Email = require('../models/CompanyReportEmail');
const Connections = require('../models/CompanyTelegramConnection');
const { resolveCompanyAccess, toPortalPermissions } = require('../services/companyAccessService');
const { buildWorkspaceResult } = require('../services/portalWorkspace/factory');
const controller = require('../controllers/clientCompanyController');
const emails = require('../services/companyReportEmailService');
const mailer = require('../services/companyReportEmailMailer');
const telegram = require('../services/companyTelegramSettingsService');
const worker = require('../services/companyReportEmailWorker');
const { statementInput } = require('../services/companyDailyStatementService');

let db, company, owner, employee, foreign;
const workspace = actor => buildWorkspaceResult({ type: 'company', actor, entity: company, actorModel: 'ClientEmployee', entityModel: 'ClientCompany', permissions: toPortalPermissions(resolveCompanyAccess(actor)) });
const response = () => { const res = {}; res.status = jest.fn(() => res); res.json = jest.fn(() => res); res.redirect = jest.fn(() => res); return res; };
const request = (actor, target, body) => ({ session: { isClientLoggedIn: true, accountType: 'company', clientId: actor._id }, params: { id: target._id }, headers: { accept: 'application/json' }, body });

beforeAll(async () => {
    process.env.SESSION_SECRET ||= require('crypto').randomBytes(32).toString('hex');
    process.env.TELEGRAM_WEBHOOK_SECRET = 'local-test-secret';
    db = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(db.getUri());
    await Promise.all([Connections.init(), Email.init()]);
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await db.stop(); });
beforeEach(async () => {
    await Promise.all([Company.deleteMany({}), Staff.deleteMany({}), Email.deleteMany({}), Connections.deleteMany({})]);
    const tenantId = new mongoose.Types.ObjectId();
    company = await Company.create({ name: 'Demo', status: 'active', tenantId, sandboxSource: { reference: 'test-demo' } });
    const second = await Company.create({ name: 'Foreign', status: 'active', tenantId, sandboxSource: { reference: 'test-foreign' } });
    owner = await Staff.create({ companyId: company._id, tenantId, name: 'Owner', role: 'owner', corporateRole: 'manager', webUsername: 'owner@ahram.com', webPassword: '$2test' });
    employee = await Staff.create({ companyId: company._id, tenantId, name: 'Worker', role: 'employee', corporateRole: 'employee', webUsername: 'worker@ahram.com', webPassword: '$2test' });
    foreign = await Staff.create({ companyId: second._id, tenantId, name: 'Foreign', role: 'employee', corporateRole: 'employee', webUsername: 'foreign@ahram.com', webPassword: '$2test' });
});

test('owner saves explicit permissions and revokes old sessions; stale writes are rejected', async () => {
    const body = { permissionsMode: 'custom', version: '0', permission_canCreateTransfer: 'on', permission_canViewAllReports: 'on' };
    const res = response();
    await controller.postUpdateStaffPermissions(request(owner, employee, body), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, code: 'permissions' });
    const updated = await Staff.findById(employee._id);
    expect(updated.sessionVersion).toBe(1);
    expect(resolveCompanyAccess(updated)).toMatchObject({ owner: false, canManageTeam: false, canViewAllReports: true });
    const stale = response();
    await controller.postUpdateStaffPermissions(request(owner, employee, body), stale);
    expect(stale.status).toHaveBeenCalledWith(409);
});

test.each(['foreign','self','employee'])('blocks %s permission changes', async kind => {
    const actor = kind === 'employee' ? employee : owner;
    const target = kind === 'foreign' ? foreign : owner;
    const res = response();
    await controller.postUpdateStaffPermissions(request(actor, target, { permissionsMode: 'custom', version: '0' }), res);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'forbidden' });
    expect((await Staff.findById(target._id)).sessionVersion).toBe(0);
});

test('new company accounts can receive reporting access without becoming company owners', async () => {
    const res = response();
    await controller.postAddStaff(request(owner, employee, { name: 'Demo staff', phone: '0910000109', webUsername: 'new_reporter', webPassword: 'TemporaryDemo123!', role: 'employee', permissionsMode: 'custom', permission_canViewAllReports: 'on' }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true, code: 'created' });
    const created = await Staff.findOne({ webUsername: 'new_reporter@ahram.com' });
    expect(resolveCompanyAccess(created)).toMatchObject({ owner: false, canManageTeam: false, canCreateTransfer: false, canViewAllReports: true });
});

test.each([{name:'x'}, {phone:'invalid'}, {webPassword:'x'.repeat(129)}, {permissionsMode:'unsupported'}])('rejects invalid staff input at the server: %j', async override => {
    const res=response();
    await controller.postAddStaff(request(owner,employee,{name:'Demo staff',phone:'0910000109',webUsername:'invalid_staff',webPassword:'DemoPassword123!',role:'employee',permissionsMode:'basic',...override}),res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({success:false}));
    expect(await Staff.exists({webUsername:'invalid_staff@ahram.com'})).toBeNull();
});

test('email verification is actor scoped and uses the company comprehensive report for the previous Libya day', async () => {
    const w = workspace(owner);
    const pending = await emails.requestCode(w, 'demo@example.com');
    const code = mailer.sendCode.mock.calls.at(-1)[1];
    const verified = await emails.verifyCode(w, pending.challengeId, code);
    expect(verified).toMatchObject({ enabled: true, verified: true, email: 'demo@example.com' });
    await expect(emails.getStatus(workspace(employee))).rejects.toMatchObject({ statusCode: 403 });
    const input = statementInput(w, '2026-10-26');
    expect(input).toMatchObject({ mainCategory: 'company', subId: String(company._id), dateType: 'day', dateValue: '2026-10-26' });
    expect(worker.dueDay(new Date('2026-10-26T22:05:00Z'))).toBe('2026-10-26');
    expect(worker.dueDay(new Date('2026-10-26T22:04:00Z'))).toBeNull();
    const subscription = await Email.findOne({ actorId: owner._id }).lean();
    expect((await worker.loadWorkspace(subscription)).entity._id).toEqual(company._id);
    await Staff.updateOne({ _id: owner._id }, { $set: { status: 'banned' } });
    await expect(worker.loadWorkspace(subscription)).rejects.toMatchObject({ statusCode: 403 });
});

test('Telegram links use one-use company tokens and allow independent names, pause and removal', async () => {
    const w = workspace(owner);
    const pending = await telegram.requestLink(w, 'هاتف المكتب');
    expect(pending.code).toMatch(/^CMP-/);
    expect(pending).toHaveProperty('connectionId');
    const linked = await telegram.confirmLink({ code: pending.code, chatId: '1234567', telegramUser: { first_name: 'Demo' } });
    expect(linked.success).toBe(true);
    expect((await telegram.confirmLink({ code: pending.code, chatId: '1234567' })).success).toBe(false);
    expect((await telegram.rename(w, pending.connectionId, 'مكتب طرابلس')).connections[0].name).toBe('مكتب طرابلس');
    expect((await telegram.setEnabled(w, false, pending.connectionId)).connections[0].enabled).toBe(false);
    await expect(telegram.status(workspace(employee))).rejects.toMatchObject({ statusCode: 403 });
    expect((await telegram.unlink(w, pending.connectionId)).connections).toHaveLength(0);
});

test('a pending Telegram link cannot be activated after the requesting manager loses permission', async () => {
    const pending = await telegram.requestLink(workspace(owner), 'المكتب');
    await Staff.updateOne({ _id: owner._id }, { $set: { status: 'banned' } });
    expect((await telegram.confirmLink({ code: pending.code, chatId: '1234567' })).success).toBe(false);
});
