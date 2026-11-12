'use strict';
jest.mock('../services/externalApiService', () => ({ getApiProviderBalance: jest.fn(), getApiProviderTransactions: jest.fn() }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Group = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Audit = require('../models/ApiBalanceAudit');
const Return = require('../models/ApiProviderReturn');
const Message = require('../models/ExecutorTeamMessage');
const ReadState = require('../models/ExecutorTeamReadState');
const Ticket = require('../models/SupportTicket');
const Notification = require('../models/Notification');
const chat = require('../services/executorTeamChatService');
const support = require('../services/executorSupportService');
const { parseProfitPercent } = require('../utils/apiProfitCommission');
const { getApiProfitCommissionReport } = require('../services/apiProfitCommissionService');
const { startApiBalanceAudit, finishApiBalanceAudit } = require('../services/apiProviderReconciliationService');
const { getApiProviderBalance } = require('../services/externalApiService');
let mongo;
let serial = 0;
const models = [Group, Employee, Transaction, Audit, Return, Message, ReadState, Ticket, Notification];
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all(models.map(model => model.init())); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await Promise.all(models.map(model => model.deleteMany({}))); jest.clearAllMocks(); });
async function fixture() {
    const group = await Group.create({ name: 'Isolated company', balance: 1000, apiProfitCommissionPercent: 10 });
    const other = await Group.create({ name: 'Other company', balance: 500 });
    const employee = await Employee.create({ name: 'Operator', webUsername: 'operator-isolated', webPassword: 'test-only-password', status: 'active', role: 'operator', groupId: group.id });
    const colleague = await Employee.create({ name: 'Colleague', webUsername: 'colleague-isolated', webPassword: 'test-only-password', status: 'active', role: 'operator', groupId: group.id });
    const outsider = await Employee.create({ name: 'Outsider', webUsername: 'outsider-isolated', webPassword: 'test-only-password', status: 'active', role: 'manager', groupId: other.id });
    const tx = await Transaction.create({ customId: 'MERGE-' + (++serial), status: 'completed', amount: 100, transferType: 'vodafone', vodafoneNumber: '01012345678', operatorId: employee.id, executorGroupId: group.id });
    return { group, other, employee, colleague, outsider, tx };
}
test.each([[], {}, true, '', '1.00001', 100, -1])('rejects invalid commission input: %j', input => { expect(() => parseProfitPercent(input)).toThrow(); });
test('preserves the rate captured before payment and reports confirmed observed profit once', async () => {
    const { group, tx } = await fixture();
    getApiProviderBalance.mockResolvedValueOnce({ success: true, availableBalance: 1000 }).mockResolvedValueOnce({ success: true, availableBalance: 910 });
    const audit = await startApiBalanceAudit({ tx, executorGroup: group });
    group.apiProfitCommissionPercent = 20;
    await finishApiBalanceAudit({ audit, tx, executorGroup: group, apiResult: { success: true } });
    expect(audit.expectedDebit).toBe(90);
    expect(audit.profitCommissionPercent).toBe(10);
    expect(audit.profitCommission).toBe(10);
    expect((await getApiProfitCommissionReport(group)).summary).toMatchObject({ profit: 10, amount: 100, cost: 90, confirmedCount: 1 });
    await Audit.create({ ...audit.toObject(), _id: new mongoose.Types.ObjectId(), createdAt: new Date(Date.now() + 1000), updatedAt: new Date() });
    expect((await getApiProfitCommissionReport(group)).summary.confirmedCount).toBe(1);
    await Return.create({ executorGroupId: group.id, transactionId: tx.id, transactionCustomId: tx.customId, providerTransactionId: 'returned-1' });
    expect((await getApiProfitCommissionReport(group)).summary.confirmedCount).toBe(0);
});
test('team messages stay separate from support, mentions stay within the company and unread is cleared on reading', async () => {
    const { employee, colleague, outsider, tx } = await fixture();
    await expect(chat.send({ executorId: employee.id, payload: { message: '@Outsider', mentionIds: [outsider.id] } })).rejects.toMatchObject({ code: 'INVALID_MENTIONS' });
    await chat.send({ executorId: employee.id, payload: { message: '@Colleague', mentionIds: [colleague.id], transactionRef: tx.customId } });
    expect(await Ticket.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(1);
    expect(await chat.unread({ executorId: colleague.id })).toEqual({ unreadCount: 1 });
    const own = await chat.conversation({ executorId: colleague.id });
    expect(own.ticket.messages[0].linkedOperation.recipient).toBe('••••5678');
    expect(await chat.unread({ executorId: colleague.id })).toEqual({ unreadCount: 0 });
    expect((await chat.conversation({ executorId: outsider.id })).ticket.messages).toHaveLength(0);
    expect(await Notification.countDocuments({ targetId: colleague.id })).toBe(1);
});
test('a reassigned employee cannot search or attach a previous company operation', async () => {
    const { employee, other, tx } = await fixture();
    await Transaction.updateOne({ _id: tx.id }, { $set: { executorGroupId: other.id } });
    expect((await chat.operations({ executorId: employee.id, search: tx.customId })).operations).toHaveLength(0);
    await expect(support.resolveLinkedTransaction({ employee, transactionRef: tx.customId })).rejects.toMatchObject({ code: 'TRANSACTION_NOT_ACCESSIBLE' });
});
test('company images cannot be opened by another company and suspended members cannot read messages', async () => {
    const { employee, outsider, group } = await fixture();
    const message = await Message.create({ groupId: group.id, senderId: employee.id, senderName: 'Operator', imageUrl: '/uploads/support/local.png' });
    expect(await chat.image({ executorId: employee.id, messageId: message.id })).toMatch(/local.png$/);
    await expect(chat.image({ executorId: outsider.id, messageId: message.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await Employee.updateOne({ _id: employee.id }, { $set: { status: 'suspended' } });
    await expect(chat.conversation({ executorId: employee.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

test('support replies persist a masked linked operation without changing financial data', async () => {
    const { employee, tx, group } = await fixture();
    await support.replyToExecutorGroupChat({ executorId: employee.id, payload: { transactionRef: tx.customId } });
    const ticket = await Ticket.findOne({ entityType: 'executor_group', entityId: group.id });
    expect(ticket.messages.find(message => message.linkedOperation)?.linkedOperation).toMatchObject({ customId: tx.customId, recipient: '••••5678' });
    expect((await Transaction.findById(tx.id)).amount).toBe(100);
    expect((await Group.findById(group.id)).balance).toBe(1000);
});
test('chat index preparation can target the live project from a detached checkout and only prepares two chat collections', async () => {
    const { spawnSync } = require('node:child_process');
    const path = require('node:path');
    const script = path.resolve(__dirname, '../scripts/prepareExecutorTeamChat.cjs');
    const run = apply => spawnSync(process.execPath, [script, '--project', path.resolve(__dirname, '..'), ...(apply ? ['--apply'] : [])], {
        env: { ...process.env, MONGO_URI: mongo.getUri('chat_index_preparation') }, encoding: 'utf8', windowsHide: true
    });
    expect(run(false).status).toBe(2);
    const apply = run(true);
    expect(apply.status).toBe(0);
    expect(JSON.parse(apply.stdout)).toMatchObject({ ready: true, financialDataChanged: false, processesChanged: false });
    expect(run(false).status).toBe(0);
    const collections = await mongoose.connection.getClient().db('chat_index_preparation').listCollections({}, { nameOnly: true }).toArray();
    expect(collections.map(item => item.name).sort()).toEqual(['executorteammessages', 'executorteamreadstates']);
});
test('profit partial renders its save action only for a master and keeps the CSRF field', () => {
    const ejs = require('ejs'); const fs = require('node:fs'); const path = require('node:path');
    const source = fs.readFileSync(path.resolve(__dirname, '../views/partials/api_profit_commission.ejs'), 'utf8');
    const data = { bot: { _id: 'group-1', status: 'active', apiProfitCommissionPercent: 0.4 }, query: {}, profitReport: { summary: { profit: 4, cost: 996, amount: 1000, confirmedCount: 1 }, entries: [] }, csrfToken: 'synthetic-csrf' };
    expect(ejs.render(source, { ...data, isMaster: false })).not.toContain('<form');
    expect(ejs.render(source, { ...data, isMaster: true })).toContain('name="_csrf" value="synthetic-csrf"');
});
