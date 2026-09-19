'use strict';

require('dotenv').config();

const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { DEMO_WARNING, assertDemoScriptAllowed } = require('./utils/scriptSafety');

const generatePlaceholder = (prefix) => `${prefix}-${crypto.randomBytes(9).toString('hex')}`;

async function main() {
    assertDemoScriptAllowed('seed-accounts.js');

    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vodafone_cash_system';
    const demoPassword = process.env.SEED_DEMO_PASSWORD || generatePlaceholder('DemoOnly');
    const zaynApiToken = process.env.SEED_ZAYN_API_GROUP_TOKEN || generatePlaceholder('demo-zayn-token');

    await mongoose.connect(mongoUri);
    const hp = await bcrypt.hash(demoPassword, 12);
    const db = mongoose.connection.db;

    await db.collection('users').updateOne(
        { phone: '01000000001' },
        {
            $set: {
                phone: '01000000001',
                name: 'Test User',
                webPassword: hp,
                status: 'active',
                balance: 500,
                telegramId: '11111'
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );

    await db.collection('clientbots').updateOne(
        { username: 'test_company' },
        {
            $set: {
                name: 'Test Company',
                username: 'test_company',
                token: '',
                balance: 5000,
                status: 'active',
                defaultEmployeePassword: ''
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );
    const cb = await db.collection('clientbots').findOne({ username: 'test_company' });

    await db.collection('clientemployees').updateOne(
        { phone: '01000000002' },
        {
            $set: {
                phone: '01000000002',
                name: 'Test Emp',
                webPassword: hp,
                status: 'active',
                clientBotId: cb._id,
                telegramId: '22222'
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );

    await db.collection('executorbots').updateOne(
        { username: 'test_execbot' },
        {
            $set: {
                name: 'Test ExecBot',
                username: 'test_execbot',
                token: 'demo-local-only',
                status: 'active',
                defaultEmployeePassword: ''
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );
    const eb = await db.collection('executorbots').findOne({ username: 'test_execbot' });

    await db.collection('executorgroups').updateOne(
        { _id: eb._id },
        {
            $set: {
                name: 'Test ExecBot',
                status: 'active',
                balance: 0,
                isManagerGroup: true,
                isApiBot: false,
                isApiGroup: false
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );

    await db.collection('employees').updateOne(
        { phone: '01000000003' },
        {
            $set: {
                phone: '01000000003',
                name: 'Test Executor',
                webPassword: hp,
                status: 'active',
                botId: eb._id,
                groupId: eb._id,
                telegramId: '33333'
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );

    await db.collection('executorbots').updateOne(
        { username: 'zayn_api_bot' },
        {
            $set: {
                name: 'بوابة ZaynPay الآلية (تجريبي)',
                username: 'zayn_api_bot',
                token: zaynApiToken,
                status: 'active',
                isApiBot: true,
                isApiGroup: true
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );
    const zaynBot = await db.collection('executorbots').findOne({ username: 'zayn_api_bot' });

    await db.collection('executorgroups').updateOne(
        { _id: zaynBot._id },
        {
            $set: {
                name: 'بوابة ZaynPay الآلية (تجريبي)',
                status: 'active',
                balance: 50000,
                isManagerGroup: false,
                isApiBot: true,
                isApiGroup: true
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );

    await db.collection('employees').updateOne(
        { webUsername: 'demo.zaynapi@localhost' },
        {
            $set: {
                phone: '01000000017',
                name: 'Demo Zayn Api',
                webPassword: hp,
                status: 'active',
                botId: zaynBot._id,
                groupId: zaynBot._id,
                telegramId: 'demo_zayn_api_tg',
                role: 'operator',
                webUsername: 'demo.zaynapi@localhost'
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );

    console.log(DEMO_WARNING);
    console.log('DONE');
    console.log('ClientBot ID:', cb._id);
    console.log('ExecBot ID:', eb._id);
    console.log('Zayn Bot ID:', zaynBot._id);
    console.log('Demo username: 01000000001');
    console.log(`Demo password (printed once, not committed): ${demoPassword}`);
    console.log('Set SEED_DEMO_PASSWORD to reuse a local placeholder. Operators must set real secrets out of band.');
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error.message || error);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
});
