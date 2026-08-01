'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const SubAccount = require('../models/SubAccount');
const Settings = require('../models/Settings');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const Counter = require('../models/Counter');

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vodafone_cash_system?replicaSet=rs0';
const password = '12345678';

const hashPassword = () => bcrypt.hash(password, 12);

const upsertOne = async (Model, filter, payload) => {
    await Model.updateOne(
        filter,
        {
            $set: { ...payload, updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true, strict: false }
    );
    return Model.findOne(filter);
};

const seedTransactions = async ({ directUser, company, companyOwner, agent, subClient, executorGroup, executor }) => {
    const samples = [
        {
            customId: 'ATT-LOCAL-0001',
            userId: directUser.phone,
            companyName: directUser.name,
            employeeName: directUser.name,
            transferType: 'vodafone',
            vodafoneNumber: '01098765432',
            amount: 100,
            costLYD: 15.38,
            exchangeRate: 6.5,
            status: 'completed',
            executorGroupId: executorGroup._id,
            executorGroupName: executorGroup.name,
            operatorId: String(executor._id),
            executorName: executor.name,
            notes: 'عملية محلية مكتملة لاختبار تطبيق Flutter'
        },
        {
            customId: 'ATT-LOCAL-0002',
            userId: companyOwner.phone,
            companyId: company._id,
            companyName: company.name,
            employeeName: companyOwner.name,
            transferType: 'post_account',
            accountNumber: '1234567890',
            accountName: 'مستلم تجريبي رباعي',
            amount: 250,
            costLYD: 39.06,
            exchangeRate: 6.4,
            status: 'pending',
            notes: 'عملية شركة قيد الانتظار'
        },
        {
            customId: 'ATT-LOCAL-0003',
            userId: subClient.phone,
            subAccountId: subClient._id,
            subAccountName: subClient.name,
            companyName: agent.name,
            employeeName: subClient.name,
            isSubAccountTx: true,
            transferType: 'post_card',
            accountName: 'مستلم بطاقة رباعي',
            amount: 180,
            costLYD: 28.13,
            subAccountCostLYD: 30,
            exchangeRate: 6.4,
            subClientRate: 6,
            commission: 1.87,
            masterProfit: 1.87,
            status: 'processing',
            notes: 'عملية عميل تابع لوكيل'
        },
        {
            customId: 'ATT-LOCAL-0004',
            userId: directUser.phone,
            companyName: directUser.name,
            employeeName: directUser.name,
            transferType: 'vodafone',
            vodafoneNumber: '01011112222',
            amount: 75,
            costLYD: 11.54,
            exchangeRate: 6.5,
            status: 'rejected',
            notes: 'عملية ملغاة للتأكد من ألوان السجل'
        }
    ];

    for (const tx of samples) {
        await upsertOne(Transaction, { customId: tx.customId }, tx);
    }

    await Counter.updateOne(
        { name: 'transaction' },
        { $set: { value: 4 } },
        { upsert: true }
    );
};

const seedTickets = async ({ directUser, subClient, executor }) => {
    const tickets = [
        {
            ticketId: 'TCK-LOCAL-001',
            entityType: 'client_user',
            entityId: directUser._id,
            telegramId: directUser.telegramId,
            name: directUser.name,
            phone: directUser.phone,
            status: 'open',
            unreadAdmin: 1,
            messages: [
                { sender: 'user', senderName: directUser.name, text: 'أحتاج مراجعة عملية التحويل الأخيرة.' },
                { sender: 'admin', senderName: 'الدعم الفني', text: 'تم استلام طلبك وجاري المراجعة.' }
            ]
        },
        {
            ticketId: 'TCK-LOCAL-002',
            entityType: 'sub_client',
            entityId: subClient._id,
            name: subClient.name,
            phone: subClient.phone,
            status: 'answered',
            unreadAdmin: 0,
            messages: [
                { sender: 'user', senderName: subClient.name, text: 'استفسار عن الحد الائتماني.' },
                { sender: 'admin', senderName: 'الدعم الفني', text: 'الحد الائتماني ظاهر في بيانات الحساب.' }
            ]
        },
        {
            ticketId: 'TCK-LOCAL-003',
            entityType: 'executor',
            entityId: executor._id,
            name: executor.name,
            phone: executor.phone,
            status: 'open',
            unreadAdmin: 1,
            messages: [
                { sender: 'user', senderName: executor.name, text: 'طلب دعم من منفذ محلي.' }
            ]
        }
    ];

    for (const ticket of tickets) {
        await upsertOne(SupportTicket, { ticketId: ticket.ticketId }, ticket);
    }
};

const main = async () => {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });

    const hp = await hashPassword();

    await upsertOne(Settings, {}, {
        rateLevel1: 6.4,
        rateLevel2: 6.45,
        rateLevel3: 6.5,
        isManualClosed: false,
        openingTime: '00:00',
        closingTime: '23:59',
        supportContact: '@LocalAhramSupport'
    });

    const directUser = await upsertOne(User, { webUsername: 'client.direct' }, {
        name: 'عميل مباشر محلي',
        phone: '01000000001',
        webUsername: 'client.direct',
        webPassword: hp,
        status: 'active',
        role: 'user',
        tier: 3,
        balance: 5000,
        creditLimit: 0,
        accountCode: 'CL-LOCAL-001',
        telegramId: 'local-client-direct'
    });

    const agent = await upsertOne(User, { webUsername: 'agent.owner' }, {
        name: 'وكيل محلي',
        phone: '01000000006',
        webUsername: 'agent.owner',
        webPassword: hp,
        status: 'active',
        role: 'agent',
        tier: 2,
        balance: 100000,
        creditLimit: 0,
        accountCode: 'AG-LOCAL-001',
        agentCode: 'AGTLOCAL',
        telegramId: 'local-agent-owner'
    });

    const subClient = await upsertOne(SubAccount, { webUsername: 'agent.client' }, {
        masterType: 'user',
        masterId: agent._id,
        name: 'عميل تابع لوكيل محلي',
        phone: '01000000007',
        webUsername: 'agent.client',
        webPassword: hp,
        status: 'active',
        balance: 300,
        creditLimit: 2000,
        customMargin: 0.1,
        cardMargin: 0.2,
        accountCode: 'SUB-LOCAL-001'
    });

    const company = await upsertOne(ClientCompany, { accountCode: 'CO-LOCAL-001' }, {
        name: 'شركة محلية للاختبار',
        phone: '01000000002',
        status: 'active',
        tier: 1,
        balance: 25000,
        creditLimit: 10000,
        accountCode: 'CO-LOCAL-001'
    });

    const companyOwner = await upsertOne(ClientEmployee, { webUsername: 'company.owner' }, {
        companyId: company._id,
        name: 'مدير شركة محلي',
        phone: '01000000002',
        webUsername: 'company.owner',
        webPassword: hp,
        status: 'active',
        role: 'owner',
        canViewAllReports: true,
        telegramId: 'local-company-owner'
    });

    const companyEmployee = await upsertOne(ClientEmployee, { webUsername: 'company.employee' }, {
        companyId: company._id,
        name: 'موظف شركة محلي',
        phone: '01000000004',
        webUsername: 'company.employee',
        webPassword: hp,
        status: 'active',
        role: 'employee',
        canViewAllReports: false,
        telegramId: 'local-company-employee'
    });

    const companyAccountant = await upsertOne(ClientEmployee, { webUsername: 'company.accountant' }, {
        companyId: company._id,
        name: 'محاسب شركة محلي',
        phone: '01000000005',
        webUsername: 'company.accountant',
        webPassword: hp,
        status: 'active',
        role: 'accountant',
        canViewAllReports: true,
        telegramId: 'local-company-accountant'
    });

    const managerGroup = await upsertOne(ExecutorGroup, { name: 'مجموعة تنفيذ رئيسية محلية' }, {
        name: 'مجموعة تنفيذ رئيسية محلية',
        status: 'active',
        balance: 150000,
        isManagerGroup: true,
        isManagerBot: true,
        isApiGroup: false,
        isApiBot: false
    });

    const executorGroup = await upsertOne(ExecutorGroup, { name: 'مجموعة منفذ محلية' }, {
        name: 'مجموعة منفذ محلية',
        status: 'active',
        balance: 50000,
        parentGroupId: managerGroup._id,
        isManagerGroup: false,
        isApiGroup: false,
        isApiBot: false
    });

    const executor = await upsertOne(Employee, { webUsername: 'executor.operator' }, {
        name: 'منفذ محلي',
        phone: '01000000003',
        role: 'operator',
        status: 'active',
        groupId: executorGroup._id,
        botId: executorGroup._id,
        webUsername: 'executor.operator',
        webPassword: hp,
        canViewAllReports: true,
        telegramId: 'local-executor'
    });

    await seedTransactions({ directUser, company, companyOwner, agent, subClient, executorGroup, executor });
    await seedTickets({ directUser, subClient, executor });

    console.log('Local mobile demo seed completed.');
    console.table([
        { role: 'direct client', username: 'client.direct', phone: '01000000001', password },
        { role: 'agent owner', username: 'agent.owner', phone: '01000000006', password },
        { role: 'agent client', username: 'agent.client', phone: '01000000007', password },
        { role: 'company owner', username: 'company.owner', phone: '01000000002', password },
        { role: 'company employee', username: 'company.employee', phone: '01000000004', password },
        { role: 'company accountant', username: 'company.accountant', phone: '01000000005', password },
        { role: 'executor', username: 'executor.operator', phone: '01000000003', password }
    ]);

    await mongoose.disconnect();
};

main().catch(async (error) => {
    console.error(error);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
});
