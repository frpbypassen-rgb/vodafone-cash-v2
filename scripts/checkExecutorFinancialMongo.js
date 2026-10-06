'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
mongoose.set('autoIndex', process.env.TEST_AUTO_INDEX === 'true');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const SupportTicket = require('../models/SupportTicket');
const Settings = require('../models/Settings');
const { fundExternalExecutor } = require('../services/executorBalancePoolService');
const { createDepositRequest } = require('../services/executorDepositRequestService');
const { archiveExecutorAccount } = require('../services/executorArchiveService');

process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';

async function main() {
    const database = `codex_financial_${crypto.randomBytes(5).toString('hex')}`;
    const uri = process.env.EXECUTOR_FINANCIAL_TEST_MONGO_URI;
    if (!uri || !['127.0.0.1', 'localhost'].includes(new URL(uri).hostname)) {
        throw new Error('A local EXECUTOR_FINANCIAL_TEST_MONGO_URI is required');
    }
    await mongoose.connect(uri, {
        dbName: database,
        serverSelectionTimeoutMS: 10000,
        autoIndex: process.env.TEST_AUTO_INDEX === 'true'
    });
    try {
        if (process.env.TEST_AUTO_INDEX === 'true') {
            await Promise.all([Transaction.init(), Employee.init(), ExecutorGroup.init()]);
        }
        const group = await ExecutorGroup.create({ name: 'Financial integration test', balance: 1000 });
        const manager = { _id: new mongoose.Types.ObjectId(), role: 'manager', groupId: group._id };
        const employee = await Employee.create({
            name: 'External test executor', groupId: group._id, role: 'external', status: 'active',
            webUsername: `integration-${database}@example.test`, webPassword: '$2b$12$test'
        });
        await Transaction.collection.createIndex({ customId: 1 }, { unique: true });
        const args = { manager, employeeId: String(employee._id), type: 'deposit', amount: 100,
            note: 'integration', requestId: 'financial-integration-001' };

        const first = await fundExternalExecutor(args);
        assert.equal(first.replayed, false);
        const repeat = await fundExternalExecutor(args);
        assert.equal(repeat.replayed, true);
        assert.equal((await ExecutorGroup.findById(group._id)).balance, 900);
        assert.equal((await Employee.findById(employee._id)).balance, 100);
        assert.equal(await Transaction.countDocuments({ customId: first.customId }), 1);
        await assert.rejects(fundExternalExecutor({ ...args, amount: 120 }), { code: 'REQUEST_ID_CONFLICT' });

        const originalCreate = Transaction.create;
        Transaction.create = async () => { throw new Error('INJECTED_MOVEMENT_FAILURE'); };
        try {
            await assert.rejects(fundExternalExecutor({ ...args, requestId: 'financial-integration-002' }), /INJECTED_MOVEMENT_FAILURE/);
        } finally {
            Transaction.create = originalCreate;
        }
        assert.equal((await ExecutorGroup.findById(group._id)).balance, 900);
        assert.equal((await Employee.findById(employee._id)).balance, 100);

        const different = { ...args, requestId: 'financial-integration-003', amount: 50 };
        const outcomes = await Promise.allSettled([fundExternalExecutor(different), fundExternalExecutor(different)]);
        assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
        assert.equal((await ExecutorGroup.findById(group._id)).balance, 850);
        assert.equal((await Employee.findById(employee._id)).balance, 150);
        assert.equal(await Transaction.countDocuments({ amount: 50, operatorId: String(employee._id) }), 1);

        const parent = await ExecutorGroup.create({ name: 'Provider parent', balance: 1000 });
        const providerGroup = await ExecutorGroup.create({ name: 'Provider executor', balance: 500, parentGroupId: parent._id });
        const provider = await Employee.create({
            name: 'Provider test executor', groupId: providerGroup._id, role: 'operator', status: 'active',
            webUsername: 'zaynapi@ahram.com', webPassword: '$2b$12$test'
        });
        const payment = require('../services/zaynpayApi');
        payment.inquiry = async () => ({ billId: 'integration-bill' });
        let payCalls = 0;
        payment.pay = async () => { payCalls += 1; return { success: true, refNumber: 'REF-1', transactionNumber: 'ZP-1' }; };
        const receipt = require('../utils/manualExecutorReceipt');
        receipt.generateManualExecutorReceiptBase64 = async () => (
            `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'instapay_logo.png')).toString('base64')}`
        );
        require('../services/cancellationReceiptService').attachCancellationReceipt = async () => null;
        const controller = require('../controllers/executorTransactionController');
        const originalExists = fs.existsSync;
        const originalWrite = fs.writeFileSync;
        fs.existsSync = () => true;
        fs.writeFileSync = () => {};
        try {
            const providerTx = await Transaction.create({
                customId: `ZP-${database}-1`, amount: 100, costLYD: 10, status: 'accepted',
                transferType: 'vodafone', vodafoneNumber: '01000000000',
                operatorId: String(provider._id), executorGroupId: providerGroup._id
            });
            const request = { params: { id: String(providerTx._id) }, session: { executorId: String(provider._id) } };
            const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
            const firstResponse = response();
            await controller.executeViaZaynPay(request, firstResponse);
            assert.equal(firstResponse.body.success, true);
            assert.equal((await Transaction.findById(providerTx._id)).status, 'completed');
            assert.equal((await ExecutorGroup.findById(providerGroup._id)).balance, 400);
            assert.equal((await ExecutorGroup.findById(parent._id)).balance, 900);
            await controller.executeViaZaynPay(request, response());
            assert.equal(payCalls, 1);

            const uncertainTx = await Transaction.create({
                customId: `ZP-${database}-2`, amount: 50, costLYD: 5, status: 'accepted',
                transferType: 'vodafone', vodafoneNumber: '01000000001',
                operatorId: String(provider._id), executorGroupId: providerGroup._id
            });
            payment.pay = async () => { payCalls += 1; throw new Error('provider response lost'); };
            const uncertainRequest = { ...request, params: { id: String(uncertainTx._id) } };
            const uncertainResponse = response();
            await controller.executeViaZaynPay(uncertainRequest, uncertainResponse);
            assert.equal(uncertainResponse.body.code, 'PROVIDER_RESULT_UNRESOLVED');
            const held = await Transaction.findById(uncertainTx._id);
            assert.equal(held.status, 'processing');
            assert.equal(held.apiResultData.providerResultUnresolved, true);
            assert.equal((await ExecutorGroup.findById(providerGroup._id)).balance, 400);
            await controller.executeViaZaynPay(uncertainRequest, response());
            assert.equal(payCalls, 2);
        } finally {
            fs.existsSync = originalExists;
            fs.writeFileSync = originalWrite;
        }

        const customer = await User.create({
            name: 'Financial test customer', phone: '01099999999', balance: 100,
            webUsername: `customer-${database}@example.test`, webPassword: '$2b$12$test'
        });
        const editable = await Transaction.create({
            customId: `EDIT-${database}`, amount: 100, costLYD: 20, exchangeRate: 5,
            status: 'accepted', transferType: 'vodafone', userId: customer.phone,
            operatorId: String(provider._id), executorGroupId: providerGroup._id
        });
        const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
        const editResponse = response();
        await controller.postEditAmount({
            params: { id: String(editable._id) }, session: { executorId: String(provider._id) },
            body: { newAmount: 200, reason: 'integration test' }
        }, editResponse);
        assert.equal(editResponse.body.success, true);
        assert.equal((await User.findById(customer._id)).balance, 80);
        assert.equal((await Transaction.findById(editable._id)).costLYD, 40);

        const cancelRequest = {
            params: { id: String(editable._id) }, session: { executorId: String(provider._id) },
            body: { reason: 'integration cancellation' }
        };
        const cancelResponse = response();
        await controller.postCancelTask(cancelRequest, cancelResponse);
        assert.equal(cancelResponse.body.success, true);
        assert.equal((await User.findById(customer._id)).balance, 120);
        assert.equal((await Transaction.findById(editable._id)).status, 'rejected');
        await controller.postCancelTask(cancelRequest, response());
        assert.equal((await User.findById(customer._id)).balance, 120);

        const raced = await Transaction.create({
            customId: `RACE-${database}`, amount: 100, costLYD: 20, exchangeRate: 5,
            status: 'accepted', transferType: 'vodafone', userId: customer.phone,
            operatorId: String(provider._id), executorGroupId: providerGroup._id
        });
        const raceBase = { params: { id: String(raced._id) }, session: { executorId: String(provider._id) } };
        const raceA = response();
        const raceB = response();
        await Promise.all([
            controller.postEditAmount({ ...raceBase, body: { newAmount: 200, reason: 'race A' } }, raceA),
            controller.postEditAmount({ ...raceBase, body: { newAmount: 300, reason: 'race B' } }, raceB)
        ]);
        const finalRace = await Transaction.findById(raced._id);
        const finalCustomer = await User.findById(customer._id);
        assert.ok([200, 300].includes(finalRace.amount));
        assert.equal(finalCustomer.balance + finalRace.costLYD, 140);

        const receiptDataUrl = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'instapay_logo.png')).toString('base64')}`;
        const depositSubmitter = { id: manager._id, name: 'Integration manager', phone: '01000000002' };
        const depositResult = await createDepositRequest({
            group,
            submittedBy: depositSubmitter,
            submittedFromAdmin: true,
            amount: 75,
            note: 'atomic deposit integration',
            receipts: [receiptDataUrl]
        });
        const savedDeposit = await Transaction.findById(depositResult.id);
        const linkedTicket = await SupportTicket.findById(savedDeposit.depositRequest.supportTicketId);
        assert.equal(String(linkedTicket.metadata.depositRequest.transactionId), String(savedDeposit._id));
        assert.equal(savedDeposit.status, 'deposit_pending');

        const txCountBeforeDepositFailure = await Transaction.countDocuments();
        const originalTicketCreate = SupportTicket.create;
        SupportTicket.create = async () => { throw new Error('INJECTED_DEPOSIT_TICKET_FAILURE'); };
        try {
            await assert.rejects(createDepositRequest({
                group,
                submittedBy: depositSubmitter,
                submittedFromAdmin: true,
                amount: 80,
                receipts: [receiptDataUrl]
            }), /INJECTED_DEPOSIT_TICKET_FAILURE/);
        } finally {
            SupportTicket.create = originalTicketCreate;
        }
        assert.equal(await Transaction.countDocuments(), txCountBeforeDepositFailure);

        const archiveGroup = await ExecutorGroup.create({ name: 'Archive atomicity fixture', status: 'paused' });
        const archiveEmployee = await Employee.create({
            name: 'Archive fixture employee', groupId: archiveGroup._id, role: 'operator', status: 'active',
            webUsername: `archive-${database}@example.test`, webPassword: '$2b$12$test'
        });
        const originalSettingsUpdate = Settings.updateMany;
        Settings.updateMany = async () => { throw new Error('INJECTED_ARCHIVE_SETTINGS_FAILURE'); };
        try {
            await assert.rejects(archiveExecutorAccount({ executorId: archiveGroup._id }), /INJECTED_ARCHIVE_SETTINGS_FAILURE/);
        } finally {
            Settings.updateMany = originalSettingsUpdate;
        }
        assert.equal((await ExecutorGroup.findById(archiveGroup._id)).status, 'paused');
        assert.equal((await Employee.findById(archiveEmployee._id)).status, 'active');
        console.log(JSON.stringify({ result: 'PASS', database, concurrent: outcomes.map((outcome) => outcome.status) }));
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
