'use strict';

process.env.JWT_SECRET ||= 'deposit-regression-jwt-secret-at-least-32';
process.env.JWT_REFRESH_SECRET ||= 'deposit-regression-refresh-secret-at-least-32';

jest.mock('../services/firebasePushService', () => ({
    ...jest.requireActual('../services/firebasePushService'),
    sendPushToTokens: jest.fn()
}));
jest.mock('../services/executorWebPushService', () => ({
    sendExecutorWebPush: jest.fn().mockResolvedValue({ attempted: 0, sent: 0, failed: 0 })
}));

const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Notification = require('../models/Notification');
const PushNotificationOutbox = require('../models/PushNotificationOutbox');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const deposits = require('../services/executorDepositRequestService');
const MobilePushDevice = require('../models/MobilePushDevice');
const MobileNotificationInbox = require('../models/MobileNotificationInbox');
const { processOutboxItem } = require('../services/executorPushNotificationService');
const { sendPushToTokens } = require('../services/firebasePushService');
const mobileApi = require('../routes/mobileApi');

const app = express();
app.use(express.json());
app.use('/api/mobile', mobileApi);

jest.setTimeout(45000);
let replica;

beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replica.getUri());
    await Promise.all([Transaction.init(), SupportTicket.init(), PushNotificationOutbox.init(), Notification.init()]);
});

afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
});

test('queues a deposit alert for the receiving managers and applies a repeated approval once', async () => {
    const group = await ExecutorGroup.create({ name: 'Deposit regression group' });
    const makeEmployee = (role, groupId, webUsername) => Employee.create({
        groupId, role, name: webUsername, webUsername, webPassword: '$2b$04$fixture', status: 'active'
    });
    const manager = await makeEmployee('manager', group._id, 'deposit-regression-manager');
    const operator = await makeEmployee('operator', group._id, 'deposit-regression-operator');
    const otherGroup = await ExecutorGroup.create({ name: 'Other group' });
    const otherManager = await makeEmployee('manager', otherGroup._id, 'deposit-regression-other');
    const created = await deposits.createDepositRequest({
        group,
        submittedFromAdmin: true,
        submittedBy: { id: new mongoose.Types.ObjectId(), name: 'Fixture admin' },
        amount: 100,
        receipts: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Vb8AAAAASUVORK5CYII=']
    });
    try {
        const outbox = await PushNotificationOutbox.findOne({ transactionId: created.id }).lean();
        const fallback = await Notification.find({ audience: 'executor', txId: created.customId }).lean();
        await MobilePushDevice.create([manager, operator, otherManager].map((employee) => ({
            installationId: employee.webUsername, token: employee.webUsername,
            accountType: 'executor', accountId: String(employee._id), permissionStatus: 'authorized'
        })));
        sendPushToTokens.mockResolvedValue({ successCount: 1, failureCount: 0, responses: [] });
        await expect(processOutboxItem(outbox)).resolves.toMatchObject({ status: 'sent' });
        expect(sendPushToTokens).toHaveBeenCalledWith(expect.objectContaining({
            tokens: [manager.webUsername], androidDataOnly: true, title: 'طلب إيداع جديد من الإدارة'
        }));
        expect(await MobileNotificationInbox.countDocuments({ transactionId: created.id, accountId: String(manager._id) })).toBe(1);
        const review = (employee, approved = true) => deposits.reviewAdminDepositRequest({
            employee, requestId: created.id, approved, reason: 'Fixture reason'
        });
        await expect(review(otherManager)).rejects.toMatchObject({ status: 404 });
        await expect(review(operator)).rejects.toMatchObject({ status: 403 });
        const results = await Promise.allSettled([review(manager), review(manager)]);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(results.map((result) => result.value.transaction.status)).toEqual(['deposit', 'deposit']);
        await expect(review(manager, false)).rejects.toMatchObject({ status: 409 });
        const token = jwt.sign({ userId: String(manager._id), accountType: 'executor',
            executorGroupId: String(group._id), sessionVersion: 0 }, process.env.JWT_SECRET);
        await request(app).post('/api/mobile/executor/deposits/' + created.id + '/review')
            .set('Authorization', 'Bearer ' + token).send({ decision: 'approve' }).expect(200);
        const tx = await Transaction.findById(created.id).lean();
        const ticket = await SupportTicket.findById(tx.depositRequest.supportTicketId).lean();
        expect(ticket.messages.filter((message) => message.text?.startsWith('تم قبول الإيداع'))).toHaveLength(1);
        expect((await ExecutorGroup.findById(group._id)).balance).toBe(100);
        expect(outbox).toMatchObject({
            status: 'pending',
            audience: { type: 'group_roles', groupId: String(group._id), roles: ['manager'] },
            data: { depositRequestId: created.id }
        });
        expect(fallback.map((item) => item.userId)).toEqual([String(manager._id)]);
    } finally {
        const fs = require('node:fs/promises');
        const tx = await Transaction.findById(created.id).lean();
        await Promise.all((tx?.proofImages || []).map((image) => fs.unlink('uploads/' + image)));
    }
});
