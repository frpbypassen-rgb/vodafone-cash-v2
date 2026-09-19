'use strict';

// Creates a predictable, local-only executor team for Flutter role testing.
require('dotenv').config();

const crypto = require('crypto');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const { DEMO_WARNING, assertDemoScriptAllowed } = require('../utils/scriptSafety');

const generatePlaceholder = (prefix) => `${prefix}-${crypto.randomBytes(9).toString('hex')}`;
const groupName = 'Flutter Local Execution';

const accounts = [
    {
        label: 'manager',
        name: 'Local Executive Manager',
        phone: '0920001001',
        username: 'local_exec_manager@ahram.com',
        password: process.env.SEED_DEMO_MANAGER_PASSWORD || generatePlaceholder('DemoManager'),
        role: 'manager',
        canViewAllReports: true
    },
    {
        label: 'operator',
        name: 'Local Executive Operator',
        phone: '0920001002',
        username: 'local_exec_operator@ahram.com',
        password: process.env.SEED_DEMO_OPERATOR_PASSWORD || generatePlaceholder('DemoOperator'),
        role: 'operator',
        canViewAllReports: false
    },
    {
        label: 'accountant',
        name: 'Local Executive Accountant',
        phone: '0920001003',
        username: 'local_exec_accountant@ahram.com',
        password: process.env.SEED_DEMO_ACCOUNTANT_PASSWORD || generatePlaceholder('DemoAccountant'),
        role: 'accountant',
        canViewAllReports: true
    }
];

async function upsertExecutorGroup() {
    let group = await ExecutorGroup.findOne({ name: groupName });
    if (!group) {
        group = new ExecutorGroup({
            name: groupName,
            status: 'active',
            balance: 25000,
            serviceKey: 'vodafone',
            isManagerGroup: false,
            isManagerBot: false,
            isApiGroup: false,
            isApiBot: false
        });
    } else {
        group.status = 'active';
        group.balance = 25000;
        group.serviceKey = 'vodafone';
    }
    await group.save();
    return group;
}

async function upsertEmployee(group, account) {
    let employee = await Employee.findOne({ webUsername: account.username });
    if (!employee) {
        employee = new Employee({
            name: account.name,
            phone: account.phone,
            role: account.role,
            status: 'active',
            groupId: group._id,
            webUsername: account.username,
            webPassword: account.password,
            canViewAllReports: account.canViewAllReports
        });
    } else {
        employee.name = account.name;
        employee.phone = account.phone;
        employee.role = account.role;
        employee.status = 'active';
        employee.groupId = group._id;
        employee.webPassword = account.password;
        employee.canViewAllReports = account.canViewAllReports;
    }
    await employee.save();
    return employee;
}

async function main() {
    assertDemoScriptAllowed('scripts/seedLocalExecutorAccounts.js');
    const uri = process.env.MONGO_URI;
    if (!uri || !/mongodb:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i.test(uri)) {
        throw new Error('This script only runs with a local MongoDB URI.');
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const group = await upsertExecutorGroup();
    const created = [];

    for (const account of accounts) {
        const employee = await upsertEmployee(group, account);
        created.push({
            role: account.label,
            username: employee.webUsername,
            phone: employee.phone,
            group: group.name,
            password: account.password
        });
    }

    console.log(DEMO_WARNING);
    console.table(created);
    console.log('Passwords above are local demo placeholders printed once. Set SEED_DEMO_*_PASSWORD to reuse them.');
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
