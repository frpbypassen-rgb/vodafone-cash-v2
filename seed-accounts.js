const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

mongoose.connect('mongodb://localhost:27017/vodafone_cash_system')
.then(async () => {
    const hp = await bcrypt.hash('123456', 10);
    const db = mongoose.connection.db;

    // User
    await db.collection('users').updateOne(
        { phone: '01000000001' },
        { $set: { phone: '01000000001', name: 'Test User', webPassword: hp, status: 'active', balance: 500, telegramId: '11111' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );

    // ClientBot
    await db.collection('clientbots').updateOne(
        { username: 'test_company' },
        { $set: { name: 'Test Company', username: 'test_company', token: 'dummy', balance: 5000, status: 'active', defaultEmployeePassword: '123' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
    const cb = await db.collection('clientbots').findOne({ username: 'test_company' });

    // ClientEmployee
    await db.collection('clientemployees').updateOne(
        { phone: '01000000002' },
        { $set: { phone: '01000000002', name: 'Test Emp', webPassword: hp, status: 'active', clientBotId: cb._id, telegramId: '22222' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );

    // ExecutorBot
    await db.collection('executorbots').updateOne(
        { username: 'test_execbot' },
        { $set: { name: 'Test ExecBot', username: 'test_execbot', token: 'dummy', status: 'active', defaultEmployeePassword: '123' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
    const eb = await db.collection('executorbots').findOne({ username: 'test_execbot' });

    // ExecutorGroup
    await db.collection('executorgroups').updateOne(
        { _id: eb._id },
        { $set: { name: 'Test ExecBot', status: 'active', balance: 0, isManagerGroup: true, isApiBot: false, isApiGroup: false },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );

    // Employee
    await db.collection('employees').updateOne(
        { phone: '01000000003' },
        { $set: { phone: '01000000003', name: 'Test Executor', webPassword: hp, status: 'active', botId: eb._id, groupId: eb._id, telegramId: '33333' },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );

    // Zayn API ExecutorBot
    await db.collection('executorbots').updateOne(
        { username: 'zayn_api_bot' },
        { $set: { name: 'بوابة ZaynPay الآلية', username: 'zayn_api_bot', token: 'ZAYNPAY_API_GROUP_TOKEN', status: 'active', isApiBot: true, isApiGroup: true },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );
    const zaynBot = await db.collection('executorbots').findOne({ username: 'zayn_api_bot' });

    // Zayn API ExecutorGroup
    await db.collection('executorgroups').updateOne(
        { _id: zaynBot._id },
        { $set: { name: 'بوابة ZaynPay الآلية', status: 'active', balance: 50000, isManagerGroup: false, isApiBot: true, isApiGroup: true },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );

    // Zayn API Employee
    const zaynHp = await bcrypt.hash('MyKids0124', 10);
    await db.collection('employees').updateOne(
        { webUsername: 'zaynapi@ahram.com' },
        { $set: { 
            phone: '01096580417', 
            name: 'Zayn Api', 
            webPassword: zaynHp, 
            status: 'active', 
            botId: zaynBot._id, 
            groupId: zaynBot._id,
            telegramId: 'zayn_api_tg',
            role: 'operator',
            webUsername: 'zaynapi@ahram.com'
          },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );

    console.log('DONE');
    console.log('ClientBot ID:', cb._id);
    console.log('ExecBot ID:', eb._id);
    console.log('Zayn Bot ID:', zaynBot._id);
    process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
