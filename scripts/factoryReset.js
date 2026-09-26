// scripts/factoryReset.js
// =====================================================
// ضبط المصنع — يرفض الإنتاج. لا يطبع كلمات المرور ولا سلسلة الاتصال.
// =====================================================
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { assertExplicitNonProductionMongoUri, requireSecret } = require('./lib/productionDatabaseGuard');

const COLLECTIONS_TO_DROP = [
    'users',
    'admins',
    'clientcompanies',
    'clientemployees',
    'executorgroups',
    'employees',
    'transactions',
    'settlements',
    'reconciliations',
    'ledgers',
    'settings',
    'notifications',
    'supporttickets',
    'subaccounts',
    'counters',
    'cards',
    'storecategories',
    'storeproducts',
    'registrationrequests',
    'auditlogs',
    'tenants',
    'sessions'
];

const assertFactoryResetAllowed = (env = process.env) => {
    assertExplicitNonProductionMongoUri(env);
    requireSecret(env, 'PANEL_PASS', 14);
    requireSecret(env, 'PANEL_USER', 4);
};

const safeError = (error) => {
    const message = String(error && error.message ? error.message : 'Factory reset failed.');
    if (/mongodb(?:\+srv)?:\/\//i.test(message)) {
        return 'Factory reset failed. Details were omitted because they may contain a connection string.';
    }
    return message;
};

async function factoryReset(env = process.env) {
    console.log('Factory reset started. The connection string and password are not printed.');

    try {
        assertFactoryResetAllowed(env);
        mongoose.set('autoIndex', false);
        mongoose.set('autoCreate', false);
        await mongoose.connect(env.MONGO_URI, {
            serverSelectionTimeoutMS: 15000,
            autoIndex: false,
            autoCreate: false
        });
        console.log('Connected. The connection string was not printed.');

        const db = mongoose.connection.db;
        console.log('Dropping configured collections...');
        let dropped = 0;
        let skipped = 0;

        for (const name of COLLECTIONS_TO_DROP) {
            try {
                const exists = await db.listCollections({ name }).hasNext();
                if (exists) {
                    await db.dropCollection(name);
                    console.log(`dropped ${name}`);
                    dropped += 1;
                } else {
                    skipped += 1;
                }
            } catch (err) {
                console.log(`skipped ${name}: ${safeError(err)}`);
            }
        }

        console.log(`Collections dropped: ${dropped}. Missing collections skipped: ${skipped}.`);

        const Admin = require('../models/Admin');
        const defaultAdmin = await Admin.create({
            name: 'المدير العام',
            role: 'master',
            webUsername: env.PANEL_USER,
            webPassword: env.PANEL_PASS
        });
        console.log(`Admin username: ${defaultAdmin.webUsername}`);
        console.log('Password was taken from PANEL_PASS and was not printed.');

        const Settings = require('../models/Settings');
        const defaultSettings = await Settings.create({
            rateLevel1: 6.40,
            rateLevel2: 6.45,
            rateLevel3: 6.50,
            openingTime: '09:00',
            closingTime: '23:00',
            isManualClosed: false,
            welcomeMessage: 'مرحباً بك في منظومة الأهرام الرقمية للصرافة.',
            termsMessage: '⚠️ يرجى التأكد من الرقم قبل الإرسال.\nالتحويل يتم خلال دقائق.',
            closedMessage: 'نعتذر، المنظومة مغلقة حالياً. يرجى المحاولة في أوقات العمل الرسمية.',
            supportContact: '@AhramSupport',
            autoRouteEnabled: false,
            executorWelcomeMessage: 'أهلاً بك في لوحة تحكم التنفيذ الخاصة بشركة الأهرام.',
            executorPendingMessage: '⏳ حسابك لا يزال قيد المراجعة من قبل الإدارة.',
            executorBannedMessage: '⛔️ تم حظر حسابك. يرجى مراجعة الإدارة.'
        });
        console.log('Default settings were created.');
        console.log(`Rates: L1=${defaultSettings.rateLevel1} | L2=${defaultSettings.rateLevel2} | L3=${defaultSettings.rateLevel3}`);

        const Counter = require('../models/Counter');
        await Counter.create({ _id: 'transactionId', seq: 0 });
        console.log('Transaction counter starts at 0.');
        console.log('Factory reset finished.');
        return 0;
    } catch (error) {
        console.error(safeError(error));
        return 1;
    } finally {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    }
}

if (require.main === module) {
    factoryReset().then((code) => {
        process.exitCode = code;
    });
}

module.exports = {
    COLLECTIONS_TO_DROP,
    assertFactoryResetAllowed,
    factoryReset
};
