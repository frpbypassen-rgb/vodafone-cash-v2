'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const express = require('express');
const Link = require('../models/TelegramAccountLink');
const Connection = require('../models/AgentTelegramConnection');
const Delivery = require('../models/TelegramDelivery');
const Claim = require('../models/TelegramReceiptClaim');
const User = require('../models/User');
const AgentEmployee = require('../models/AgentEmployee');
const telegram = require('../services/telegramService');
const service = require('../services/agentTelegramSettingsService');
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');
const { buildWorkspaceResult } = require('../services/portalWorkspace/factory');
let mongo, workspace, originalFetch;
jest.setTimeout(120000);
beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token-not-real';
    process.env.TELEGRAM_BOT_USERNAME = 'Ahrampay_bot';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.TENANT_MODE = 'multi';
    originalFetch = global.fetch;
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongo.getUri());
    await Promise.all([Link.init(), Connection.init(), Delivery.init(), Claim.init()]);
});
afterAll(async () => { global.fetch = originalFetch; await mongoose.disconnect(); if (mongo) await mongo.stop(); });
beforeEach(async () => {
    for (const Model of [Link, Connection, Delivery, Claim, User, AgentEmployee]) await Model.collection.deleteMany({});
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 42, username: 'Ahrampay_bot' } }) }));
    const actor = { _id: new mongoose.Types.ObjectId(), role: 'agent', status: 'active', name: 'Agency', phone: '0911111111', webUsername: 'agency-test', tenantId: new mongoose.Types.ObjectId() };
    await User.collection.insertOne(actor);
    workspace = buildWorkspaceResult({ type: 'agent', actor, entity: actor, actorModel: 'User', entityModel: 'User', permissions: resolveAgentPermissions(actor) });
});
const link = async (chatId = '123456789') => {
    const pending = await service.requestLink(workspace, 'هاتف المدير');
    const result = await telegram.linkChatByCode({ code: pending.code, chatId });
    expect(result.success).toBe(true);
    return pending;
};
const tx = () => ({ _id: new mongoose.Types.ObjectId(), tenantId: workspace.entity.tenantId, userId: workspace.entity.phone, status: 'completed', customId: 'ATT-TEST', amount: 100 });
test('linking uses a temporary code, activates receipts and leaves WhatsApp enabled', async () => {
    const pending = await service.requestLink(workspace, 'هاتف المدير');
    expect(pending.botUrl).toBe(`https://t.me/Ahrampay_bot?start=${pending.code}`);
    expect(pending.code).toMatch(/^AGT-[a-f0-9]{48}$/);
    const stored = await Connection.findOne().select('+codeHash').lean();
    expect(stored.codeHash).not.toBe(pending.code);
    expect((await service.status(workspace)).linked).toBe(false);
    expect((await telegram.linkChatByCode({ code: pending.code, chatId: '123456789' })).success).toBe(true);
    expect(await service.status(workspace)).toMatchObject({ linked: true, enabled: true });
    expect((await Connection.findOne()).enabled).toBe(true);
    expect((await telegram.linkChatByCode({ code: pending.code, chatId: '987654321' })).success).toBe(false);
});
test('expired codes and group chat IDs cannot bind the account', async () => {
    const pending = await service.requestLink(workspace, 'هاتف المدير');
    expect((await telegram.linkChatByCode({ code: pending.code, chatId: '-10012345' })).success).toBe(false);
    await Connection.updateOne({}, { $set: { codeExpiresAt: new Date(0) } });
    expect((await telegram.linkChatByCode({ code: pending.code, chatId: '123456789' })).success).toBe(false);
});
test('adding a second named account preserves the first and both can be independently paused', async () => {
    const first = await link();
    const second = await service.requestLink(workspace, 'حساب المحاسب');
    expect((await telegram.linkChatByCode({ code: second.code, chatId: '987654321' })).success).toBe(true);
    const status = await service.status(workspace);
    expect(status.connections.map(row => row.name)).toEqual(['هاتف المدير', 'حساب المحاسب']);
    await service.setEnabled(workspace, false, first.connectionId);
    const updated = (await service.status(workspace)).connections;
    expect(updated.find(row => row.id === first.connectionId).enabled).toBe(false);
    expect(updated.find(row => row.id === second.connectionId).enabled).toBe(true);
});
test('disabled or revoked agency managers cannot complete a pending link', async () => {
    const pending = await service.requestLink(workspace, 'هاتف المدير');
    await User.collection.updateOne({ _id: workspace.entity._id }, { $set: { status: 'suspended' } });
    expect((await telegram.linkChatByCode({ code: pending.code, chatId: '123456789' })).success).toBe(false);
});
test('ordinary staff cannot change the agency receipt destination', async () => {
    const actor = { role: 'employee', _id: new mongoose.Types.ObjectId() };
    await expect(service.requestLink({ ...workspace, actor, permissions: resolveAgentPermissions(actor) }, 'موظف')).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
test('multiple pending names have no empty chat collision and a duplicate chat within the agency is rejected', async () => {
    const first = await service.requestLink(workspace, 'الأول');
    const second = await service.requestLink(workspace, 'الثاني');
    expect(await Connection.countDocuments()).toBe(2);
    expect((await telegram.linkChatByCode({ code: first.code, chatId: '123456789' })).success).toBe(true);
    expect(await telegram.linkChatByCode({ code: second.code, chatId: '123456789' })).toMatchObject({ success: false, code: 'CHAT_ALREADY_LINKED' });
});
test('deleting a pending or linked account revokes its code and does not affect another account', async () => {
    const first = await link();
    const second = await service.requestLink(workspace, 'الجهاز الثاني');
    await service.unlink(workspace, second.connectionId);
    expect((await telegram.linkChatByCode({ code: second.code, chatId: '987654321' })).success).toBe(false);
    expect((await service.status(workspace)).connections).toHaveLength(1);
    expect((await service.status(workspace)).connections[0].enabled).toBe(true);
    await service.unlink(workspace, first.connectionId);
    expect(await service.status(workspace)).toMatchObject({ linked: false, enabled: false, connections: [] });
});
test('parallel receipt sends and retries do not duplicate a photo; split proofs retain separate claims', async () => {
    await link(); const transaction = tx();
    const send = proofIndex => telegram.sendReceipt({ transaction, receiptUrl: 'https://example.test/signed-receipt', proofIndex });
    await Promise.all([send(0), send(0)]);
    await send(1); await send(0); await send(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(await Claim.countDocuments({ status: 'sent' })).toBe(2);
});
test('existing legacy links are listed, can be renamed and preserve their WhatsApp preference', async () => {
    const pending = await telegram.createAccountCode({ ownerModel: 'User', ownerId: workspace.entity._id, tenantId: workspace.entity.tenantId });
    await Link.updateOne({}, { $set: { deliveryMode: 'telegram' } });
    expect((await telegram.linkChatByCode({ code: pending.code, chatId: '123456789' })).success).toBe(true);
    expect((await service.status(workspace)).connections[0].id).toBe('legacy');
    await service.rename(workspace, 'legacy', 'الحساب السابق');
    expect((await service.status(workspace)).connections[0].name).toBe('الحساب السابق');
    await service.setEnabled(workspace, false, 'legacy');
    expect((await Link.findOne()).deliveryMode).toBe('off');
    await service.setEnabled(workspace, true, 'legacy');
    expect((await Link.findOne()).deliveryMode).toBe('telegram');
});
test('receipt lookup does not cross tenants', async () => {
    await link();
    expect(await telegram.findLinkForTransaction({ ...tx(), tenantId: new mongoose.Types.ObjectId() })).toBeNull();
    expect(await telegram.findLinkForTransaction({ ...tx(), tenantId: null })).toBeNull();
});
test('ambiguous network failures cannot automatically resend an already attempted receipt', async () => {
    await link(); const transaction = tx();
    global.fetch.mockRejectedValueOnce(new Error('timeout'));
    await expect(telegram.sendReceipt({ transaction, receiptUrl: 'https://example.test/image' })).rejects.toThrow();
    expect(await telegram.sendReceipt({ transaction, receiptUrl: 'https://example.test/image' })).toMatchObject({ code: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('webhook authenticates Telegram, supports /start links and ignores group messages', async () => {
    const pending = await service.requestLink(workspace, 'هاتف المدير');
    const app = express(); app.use(express.json()); app.use('/webhooks/telegram', require('../routes/telegramWebhook'));
    const body = { message: { text: `/start ${pending.code}`, chat: { id: 123456789, type: 'private' } } };
    expect((await request(app).post('/webhooks/telegram').send(body)).status).toBe(401);
    expect((await request(app).post('/webhooks/telegram').set('X-Telegram-Bot-Api-Secret-Token', 'test-webhook-secret').send({ message: { ...body.message, chat: { id: -12345, type: 'group' } } })).status).toBe(200);
    expect((await service.status(workspace)).linked).toBe(false);
    expect((await request(app).post('/webhooks/telegram').set('X-Telegram-Bot-Api-Secret-Token', 'test-webhook-secret').send(body)).status).toBe(200);
    expect((await service.status(workspace)).linked).toBe(true);
});
test('receipts fan out only to enabled accounts, and pausing one leaves the other active', async () => {
    const first = await link('123456789');
    const second = await service.requestLink(workspace, 'حساب المحاسب');
    await telegram.linkChatByCode({ code: second.code, chatId: '987654321', telegramUser: { username: 'accountant', first_name: 'المحاسب' } });
    await service.setEnabled(workspace, false, first.connectionId);
    const receipt = { transaction: tx(), receiptUrl: 'https://example.test/receipt' };
    expect(await telegram.sendReceipt(receipt)).toMatchObject({ success: true, sentCount: 1 });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).chat_id).toBe('987654321');
    await service.setEnabled(workspace, true, first.connectionId);
    global.fetch.mockClear();
    expect(await telegram.sendReceipt({ ...receipt, transaction: tx() })).toMatchObject({ success: true, sentCount: 2 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
});
test('rename and per-account test target only the selected connection', async () => {
    const first = await link();
    const renamed = await service.rename(workspace, first.connectionId, 'هاتف المدير الجديد');
    expect(renamed.connections[0].name).toBe('هاتف المدير الجديد');
    await service.sendTest(workspace, first.connectionId);
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.chat_id).toBe('123456789');
    expect(payload.text).toContain('هاتف المدير الجديد');
});
test('foreign agency connection IDs cannot be renamed, paused, deleted or tested', async () => {
    const first = await link();
    const foreign = { ...workspace, entity: { ...workspace.entity, _id: new mongoose.Types.ObjectId() } };
    await expect(service.rename(foreign, first.connectionId, 'غير مسموح')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.setEnabled(foreign, false, first.connectionId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.unlink(foreign, first.connectionId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.sendTest(foreign, first.connectionId)).rejects.toMatchObject({ statusCode: 404 });
});
test('renewing an expired pending link invalidates the old code without creating another card', async () => {
    const pending = await service.requestLink(workspace, 'حساب قيد التفعيل');
    const replacement = await service.requestLink(workspace, null, pending.connectionId);
    expect(await Connection.countDocuments()).toBe(1);
    expect((await telegram.linkChatByCode({ code: pending.code, chatId: '123456789' })).success).toBe(false);
    expect((await telegram.linkChatByCode({ code: replacement.code, chatId: '123456789' })).success).toBe(true);
});
test('legacy and named lists cannot register the same chat twice for an agency', async () => {
    const legacy = await telegram.createAccountCode({ ownerModel: 'User', ownerId: workspace.entity._id, tenantId: workspace.entity.tenantId });
    await telegram.linkChatByCode({ code: legacy.code, chatId: '123456789' });
    const pending = await service.requestLink(workspace, 'نفس الحساب');
    expect(await telegram.linkChatByCode({ code: pending.code, chatId: '123456789' })).toMatchObject({ code: 'CHAT_ALREADY_LINKED' });
});
test('one blocked destination does not stop the other enabled account', async () => {
    await link('123456789');
    const second = await service.requestLink(workspace, 'الحساب الثاني');
    await telegram.linkChatByCode({ code: second.code, chatId: '987654321' });
    global.fetch.mockImplementation(async (_url, options) => ({ ok: JSON.parse(options.body).chat_id !== '123456789', json: async () => ({ ok: JSON.parse(options.body).chat_id !== '123456789', result: { message_id: 42 } }) }));
    expect(await telegram.sendReceipt({ transaction: tx(), receiptUrl: 'https://example.test/receipt' })).toMatchObject({ success: true, sentCount: 1, failedCount: 1 });
});
