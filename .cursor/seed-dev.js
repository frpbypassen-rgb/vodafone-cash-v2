'use strict';

// Idempotent local development seed for the Cloud Agent environment.
// Creates the default tenant, relaxes device/location security friction so
// local logins work without geolocation hardware, and seeds demo accounts.
// This is development-only and never runs against production data.

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const clean = (value) => String(value || '').trim();

const run = async () => {
    const mongoUri = clean(process.env.MONGO_URI);
    if (!mongoUri || mongoUri.toLowerCase() === 'demo') {
        throw new Error('MONGO_URI must point to a real MongoDB instance for the dev seed.');
    }
    if (clean(process.env.NODE_ENV).toLowerCase() === 'production') {
        throw new Error('Refusing to run the development seed while NODE_ENV=production.');
    }

    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 20000 });
    const db = mongoose.connection.db;

    // 1) Default tenant -------------------------------------------------------
    const slug = clean(process.env.DEFAULT_TENANT_SLUG).toLowerCase() || 'ahram';
    const tenantName = clean(process.env.DEFAULT_TENANT_NAME) || 'Al-Ahram Pay (Dev)';
    await db.collection('tenants').updateOne(
        { slug },
        {
            $set: { slug, name: tenantName, status: 'active' },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );
    const tenant = await db.collection('tenants').findOne({ slug });
    const tenantId = tenant._id;
    console.log(`[seed] tenant ready: ${slug} (${tenantId})`);

    // 2) Relax security enforcement for frictionless local development --------
    await db.collection('securitystates').updateOne(
        { key: 'global' },
        {
            $set: {
                adminDeviceEnforcementEnabled: false,
                accountDeviceEnforcementEnabled: false,
                mandatoryAuthenticatorEnabled: false,
                adminApprovalRequired: false,
                singleDeviceOnly: false,
                adminPermissionEnforcementEnabled: true,
                locationRequired: false,
                highConfidenceVpnBlockEnabled: false,
                lockdownActive: false,
                updatedBy: 'cloud_agent_dev_seed'
            },
            $setOnInsert: { key: 'global', createdAt: new Date() }
        },
        { upsert: true }
    );
    console.log('[seed] security state relaxed for local development');

    // 3) Demo accounts (idempotent upserts, tagged with the default tenant) ---
    const pass = await bcrypt.hash('123456', 10);
    const now = new Date();

    await db.collection('users').updateOne(
        { phone: '01000000001' },
        {
            $set: {
                phone: '01000000001', name: 'Test User', webUsername: 'client1',
                webPassword: pass, status: 'active', balance: 500,
                telegramId: '11111', tenantId
            },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true }
    );

    await db.collection('clientbots').updateOne(
        { username: 'test_company' },
        {
            $set: {
                name: 'Test Company', username: 'test_company', token: 'dummy',
                balance: 5000, status: 'active', defaultEmployeePassword: '123', tenantId
            },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true }
    );
    const clientBot = await db.collection('clientbots').findOne({ username: 'test_company' });

    await db.collection('clientemployees').updateOne(
        { phone: '01000000002' },
        {
            $set: {
                phone: '01000000002', name: 'Test Emp', webUsername: 'comp_emp1',
                webPassword: pass, status: 'active', companyId: clientBot._id,
                clientBotId: clientBot._id, telegramId: '22222', tenantId
            },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true }
    );

    await db.collection('executorbots').updateOne(
        { username: 'test_execbot' },
        {
            $set: {
                name: 'Test ExecBot', username: 'test_execbot', token: 'dummy',
                status: 'active', defaultEmployeePassword: '123'
            },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true }
    );
    const execBot = await db.collection('executorbots').findOne({ username: 'test_execbot' });

    await db.collection('executorgroups').updateOne(
        { _id: execBot._id },
        {
            $set: {
                name: 'Test ExecBot', status: 'active', balance: 0,
                isManagerGroup: true, isApiBot: false, isApiGroup: false, tenantId
            },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true }
    );

    await db.collection('employees').updateOne(
        { phone: '01000000003' },
        {
            $set: {
                phone: '01000000003', name: 'Test Executor', webUsername: 'exec_mgr1',
                webPassword: pass, status: 'active', botId: execBot._id,
                groupId: execBot._id, role: 'manager', telegramId: '33333', tenantId
            },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true }
    );

    console.log('[seed] demo accounts ready');
    console.log('[seed] done');
};

run()
    .catch((error) => {
        console.error(`[seed] failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
