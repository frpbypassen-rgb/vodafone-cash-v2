'use strict';

// Adds one isolated task to the local-only Flutter executor demo group.
require('dotenv').config();

const mongoose = require('mongoose');
const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const groupName = 'Flutter Local Execution';
const taskId = 'DEMO-EXEC-MOBILE-001';
const demoCustomerPhone = '0920001999';

async function main() {
    const uri = process.env.MONGO_URI;
    if (!uri || !/mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i.test(uri)) {
        throw new Error('This script only runs with a local MongoDB URI.');
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const group = await ExecutorGroup.findOne({ name: groupName });
    const manager = await Employee.findOne({ webUsername: 'local_exec_manager@ahram.com' });
    if (!group || !manager) {
        throw new Error('Run scripts/seedLocalExecutorAccounts.js first.');
    }

    let customer = await User.findOne({ phone: demoCustomerPhone });
    if (!customer) {
        customer = new User({
            name: 'Local Demo Customer',
            phone: demoCustomerPhone,
            webUsername: 'local_demo_customer@ahram.com',
            webPassword: 'DemoCustomer2026!'
        });
    }
    customer.name = 'Local Demo Customer';
    customer.phone = demoCustomerPhone;
    customer.balance = 1250;
    customer.status = 'active';
    await customer.save();

    const receivedAt = new Date(Date.now() - (3 * 60 * 1000 + 18 * 1000));
    await Transaction.findOneAndUpdate(
        { customId: taskId },
        {
            $set: {
                transferType: 'vodafone',
                vodafoneNumber: '01108172258',
                accountName: 'عميل تجريبي محلي',
                amount: 875,
                costLYD: 147.5,
                status: 'processing',
                executorGroupId: group._id,
                executorGroupName: group.name,
                executorReceivedAt: receivedAt,
                executorName: '---',
                userId: customer.phone,
                customerNotes: 'يرجى التأكد من الاسم قبل إتمام التحويل.',
                notes: 'يرجى التأكد من الاسم قبل إتمام التحويل.',
                emergencyAlert: undefined
            },
            $unset: {
                apiResultData: '',
                completedAt: '',
                executorExecutionNumberMasked: '',
                executorSenderPhone: '',
                manualExecutorReceiptReference: '',
                proofImage: '',
                proofImages: '',
                operatorId: '',
                cancellationNumber: '',
                cancellationReason: '',
                cancelledBy: '',
                cancelledAt: ''
            },
            $setOnInsert: { customId: taskId }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`Local executor demo task ready: ${taskId}`);
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error.message);
    try {
        await mongoose.disconnect();
    } catch (_) {
        // Connection may not have been established.
    }
    process.exit(1);
});
