'use strict';

// Creates a predictable, local-only executor team for Flutter role testing.
require('dotenv').config();

const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const { assertLocalSeedTarget, requireSecret } = require('./lib/productionDatabaseGuard');

const groupName = 'Flutter Local Execution';

const accountTemplates = [
    {
        label: 'manager',
        name: 'Local Executive Manager',
        phone: '0920001001',
        username: 'local_exec_manager@ahram.com',
        secretEnv: 'SEED_LOCAL_EXEC_MANAGER_PASSWORD',
        role: 'manager',
        canViewAllReports: true
    },
    {
        label: 'operator',
        name: 'Local Executive Operator',
        phone: '0920001002',
        username: 'local_exec_operator@ahram.com',
        secretEnv: 'SEED_LOCAL_EXEC_OPERATOR_PASSWORD',
        role: 'operator',
        canViewAllReports: false
    },
    {
        label: 'accountant',
        name: 'Local Executive Accountant',
        phone: '0920001003',
        username: 'local_exec_accountant@ahram.com',
        secretEnv: 'SEED_LOCAL_EXEC_ACCOUNTANT_PASSWORD',
        role: 'accountant',
        canViewAllReports: true
    }
];

const accountsFromEnv = (env = process.env) => accountTemplates.map((account) => ({
    ...account,
    password: requireSecret(env, account.secretEnv, 8)
}));

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
    assertLocalSeedTarget(process.env);
    const accounts = accountsFromEnv(process.env);

    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
    const group = await upsertExecutorGroup();
    const created = [];

    for (const account of accounts) {
        const employee = await upsertEmployee(group, account);
        created.push({
            role: account.label,
            username: employee.webUsername,
            phone: employee.phone,
            group: group.name
        });
    }

    console.table(created);
    await mongoose.disconnect();
}

if (require.main === module) {
    main().catch(async (error) => {
    console.error(String(error && error.message || 'Seed failed.').replace(/(?:mongodb(?:\+srv)?:\/\/)\S+/gi, '[redacted]'));
    try {
        await mongoose.disconnect();
    } catch (_) {
        // Connection may not have been established.
    }
        process.exit(1);
    });
}

module.exports = { accountsFromEnv, main };
